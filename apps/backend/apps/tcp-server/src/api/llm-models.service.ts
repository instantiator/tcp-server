import { findProvider, listedModels, type LlmConfig } from '@tcp/shared';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { LlmDestinationPolicy } from '../db/llm-destination-policy';
import type { ListLlmModelsDto } from './dto/llm-models.dto';

/** Short, because a person is waiting on it in a form. */
export const LIST_MODELS_TIMEOUT_MS = 5_000;

/**
 * Lists the models a local or custom server offers, so the web picker can
 * suggest what is really there.
 *
 * The server fetches an address the caller chose, so the address must pass
 * the same {@link LlmDestinationPolicy} as saving it would. A saved key is
 * only sent back to the provider and address it was saved for.
 */
@Injectable()
export class LlmModelsService {
  constructor(
    private readonly db: DbService,
    private readonly policy: LlmDestinationPolicy,
  ) {}

  /**
   * The ids `GET {baseUrl}/models` lists, or a 400/404/502 saying why not.
   * Without a company (a form for a company not yet created) only a key the
   * caller sends is used; there is no saved one to fall back on.
   */
  async list(
    companyId: string | null,
    query: ListLlmModelsDto,
  ): Promise<string[]> {
    const kind = findProvider(query.provider)?.kind;
    if (kind !== 'local' && kind !== 'custom') {
      throw new BadRequestException(
        'Only local and custom providers can be listed.',
      );
    }
    const refusal = this.policy.refusal(query);
    if (refusal) throw new BadRequestException(`baseUrl: ${refusal}`);

    const apiKey =
      query.apiKey ||
      (companyId === null ? undefined : await this.savedKey(companyId, query));
    let res: Response;
    try {
      res = await fetch(`${query.baseUrl.replace(/\/$/, '')}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException(`Couldn't reach ${query.baseUrl}.`);
    }
    if (!res.ok) {
      throw new BadGatewayException(`${query.baseUrl} answered ${res.status}.`);
    }
    const models = listedModels(await res.json().catch(() => null));
    if (!models) {
      throw new BadGatewayException(
        `${query.baseUrl} didn't answer with a model list.`,
      );
    }
    return models;
  }

  /** A key saved on the company or the named role for this exact provider and address. */
  private async savedKey(
    companyId: string,
    { provider, baseUrl, roleId }: ListLlmModelsDto,
  ): Promise<string | undefined> {
    const company = await this.db.getCompany(companyId);
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    const role = roleId
      ? await this.db.findRoleByIdOrSlug(company.id, roleId)
      : null;
    if (roleId && !role) {
      throw new NotFoundException(
        `Role ${roleId} not found in company ${company.id}`,
      );
    }
    const saved: (LlmConfig | null | undefined)[] = [
      role?.llmConfig,
      company.llmConfig,
      company.embeddingConfig,
    ];
    return saved.find(
      (c) => c?.apiKey && c.provider === provider && c.baseUrl === baseUrl,
    )?.apiKey;
  }
}
