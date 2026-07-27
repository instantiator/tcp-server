import {
  CompanyUser,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';

/**
 * Manages the lifecycle of agent-to-human {@link Conversation} records.
 *
 * Slug generation and `queryIndex` increment are performed atomically via a
 * single `UPDATE … RETURNING` query, so concurrent creates for the same role
 * never produce duplicate slugs.
 */
@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(ConversationMessage)
    private readonly msgRepo: Repository<ConversationMessage>,
    @InjectRepository(CompanyUser)
    private readonly userRepo: Repository<CompanyUser>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    private readonly dataSource: DataSource,
  ) {}

  /** Lists conversations filtered by company and/or status. */
  async list(companyId?: UUID, status?: string): Promise<Conversation[]> {
    const where: FindOptionsWhere<Conversation> = {
      ...(companyId ? { companyId } : {}),
      ...(status ? { status: status as ConversationStatus } : {}),
    };
    return this.convRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  /** Returns a conversation together with its messages, or throws 404. */
  async get(slug: string): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
    companyTimezone: string | null;
  }> {
    const conversation = await this.convRepo.findOne({ where: { slug } });
    if (!conversation)
      throw new NotFoundException(`Conversation ${slug} not found`);
    const messages = await this.msgRepo.find({
      where: { conversationId: conversation.id },
      order: { timestamp: 'ASC' },
    });
    const company = await this.companyRepo.findOneBy({
      id: conversation.companyId,
    });
    return {
      conversation,
      messages,
      companyTimezone: company?.timezone ?? null,
    };
  }

  /**
   * Creates a conversation for an agent question.
   *
   * The `queryIndex` on the role is atomically incremented and the new value
   * used to form a slug: `{role-name}-{queryIndex}`.
   */
  async create(
    companyId: UUID,
    roleId: UUID | null,
    roleName: string,
    agentId: UUID | null,
    question: string,
    context?: string,
    userIds?: UUID[],
  ): Promise<Conversation> {
    const slugBase = roleName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    let queryIndex = 0;
    if (roleId) {
      if (this.dataSource.options.type === 'postgres') {
        // Atomic increment on PostgreSQL via RETURNING. A non-SELECT query
        // resolves to [rows, affectedRowCount] on the postgres driver, not
        // just the rows — indexing straight into the top-level result (as
        // if it were `rows[0]`) silently reads past the row array and
        // always misses, so every queryIndex would come out 0.
        const [rows] = await this.dataSource.query<
          [{ queryIndex: number }[], number]
        >(
          `UPDATE tcp_role SET "queryIndex" = "queryIndex" + 1 WHERE id = $1 RETURNING "queryIndex"`,
          [roleId],
        );
        queryIndex = rows[0]?.queryIndex ?? 0;
      } else {
        // Non-atomic fallback for SQLite (E2E tests without PostgreSQL)
        const role = await this.roleRepo.findOneBy({ id: roleId });
        if (role) {
          queryIndex = role.queryIndex + 1;
          await this.roleRepo.update(roleId, { queryIndex });
        }
      }
    }

    const slug = `${slugBase}-${queryIndex}`;

    // Target explicit users when given, validating they belong to the
    // company; otherwise fall back to the keyword-matching heuristic.
    const routedToIdentifiers = userIds
      ? await this.resolveTargetIdentifiers(companyId, userIds)
      : await this.routeQuery(companyId, question, roleName);

    const conv = this.convRepo.create({
      slug,
      companyId,
      roleName,
      roleId,
      agentId,
      question,
      context: context ?? null,
      status: 'awaiting_user',
      routedToIdentifiers,
    });
    return this.convRepo.save(conv);
  }

  /**
   * Adds a user reply, closes the conversation, and returns the updated record.
   * Throws 404 if the slug is unknown and 409 if already closed.
   */
  async reply(
    slug: string,
    content: string,
    authorIdentifier?: string,
  ): Promise<Conversation> {
    return this.dataSource.transaction(async (em) => {
      const conv = await em
        .getRepository(Conversation)
        .findOne({ where: { slug } });
      if (!conv) throw new NotFoundException(`Conversation ${slug} not found`);
      if (conv.status === 'closed')
        throw new ConflictException(`Conversation ${slug} is already closed`);

      const msg = em.getRepository(ConversationMessage).create({
        conversationId: conv.id,
        author: 'user',
        authorIdentifier: authorIdentifier ?? null,
        content,
      });
      await em.getRepository(ConversationMessage).save(msg);

      conv.status = 'closed';
      conv.closedAt = new Date();
      return em.getRepository(Conversation).save(conv);
    });
  }

  /**
   * Resolves explicit target user ids to their OIDC identifiers, validating
   * each belongs to the company. Throws 400 if any id doesn't match.
   */
  private async resolveTargetIdentifiers(
    companyId: UUID,
    userIds: UUID[],
  ): Promise<string[]> {
    const users = await this.userRepo.findBy({
      id: In(userIds),
      companyId,
    });
    const missing = userIds.filter((id) => !users.some((u) => u.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `User id(s) not found in company ${companyId}: ${missing.join(', ')}`,
      );
    }
    return users.map((u) => u.identifier);
  }

  /**
   * Routes a question to the most relevant company users.
   *
   * Matching order:
   * 1. Users whose `roles` or `knowledgeDomains` appear as substrings in the question
   * 2. Owners and creators (fallback when no member matches)
   * 3. All users (last resort)
   */
  async routeQuery(
    companyId: UUID,
    question: string,
    roleName: string,
  ): Promise<string[]> {
    const users = await this.userRepo.findBy({ companyId });
    if (users.length === 0) return [];

    const lower = question.toLowerCase();
    const roleNameLower = roleName.toLowerCase();

    const matched = users.filter(
      (u) =>
        u.roles.some(
          (r) =>
            lower.includes(r.toLowerCase()) ||
            roleNameLower.includes(r.toLowerCase()),
        ) || u.knowledgeDomains.some((d) => lower.includes(d.toLowerCase())),
    );
    if (matched.length > 0) return matched.map((u) => u.identifier);

    const owners = users.filter(
      (u) => u.memberType === 'owner' || u.memberType === 'creator',
    );
    if (owners.length > 0) return owners.map((u) => u.identifier);

    return users.map((u) => u.identifier);
  }
}
