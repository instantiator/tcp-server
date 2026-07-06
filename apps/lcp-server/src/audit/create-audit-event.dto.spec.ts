import { AuditEventType } from '@lcp/shared';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateAuditEventDto } from './create-audit-event.dto';

/**
 * Exercises the exact mechanism that broke in production: NestJS's
 * `ValidationPipe({ whitelist: true })` (configured app-wide in AppModule)
 * silently deletes any request-body property that has no class-validator
 * decorator, before validation even runs. A DTO field declared without a
 * decorator (as every field here originally was) is indistinguishable, from
 * the pipe's perspective, from a property that was never sent — it's
 * stripped, not rejected, so no error ever surfaces; the request just arrives
 * with an empty body. Only running the real pipe (not just `validate()`
 * directly) catches this class of bug.
 */
describe('CreateAuditEventDto with the app-wide ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
  });

  const validBody = () => ({
    companyId: randomUUID(),
    role: 'Auditor',
    agentId: randomUUID(),
    eventType: AuditEventType.ToolCall,
    payload: { tool: 'describe_server' },
  });

  /** Returns `validBody()` with the given key removed. */
  const withoutField = (
    key: keyof ReturnType<typeof validBody>,
  ): Partial<ReturnType<typeof validBody>> => {
    const body = validBody();
    delete body[key];
    return body;
  };

  it('keeps every field intact — none are stripped by whitelist', async () => {
    const body = validBody();
    const result = (await pipe.transform(body, {
      type: 'body',
      metatype: CreateAuditEventDto,
    })) as CreateAuditEventDto;

    expect(result.companyId).toBe(body.companyId);
    expect(result.role).toBe(body.role);
    expect(result.agentId).toBe(body.agentId);
    expect(result.eventType).toBe(body.eventType);
    expect(result.payload).toEqual(body.payload);
  });

  it('allows agentId to be omitted (system-level events)', async () => {
    const body = withoutField('agentId');
    const result = (await pipe.transform(body, {
      type: 'body',
      metatype: CreateAuditEventDto,
    })) as CreateAuditEventDto;

    expect(result.agentId).toBeUndefined();
    expect(result.companyId).toBe(body.companyId);
  });

  it('rejects a body missing companyId', async () => {
    await expect(
      pipe.transform(withoutField('companyId'), {
        type: 'body',
        metatype: CreateAuditEventDto,
      }),
    ).rejects.toThrow();
  });

  it('rejects a body missing role', async () => {
    await expect(
      pipe.transform(withoutField('role'), {
        type: 'body',
        metatype: CreateAuditEventDto,
      }),
    ).rejects.toThrow();
  });

  it('rejects a body with an invalid eventType', async () => {
    const body = { ...validBody(), eventType: 'not_a_real_event_type' };
    await expect(
      pipe.transform(body, { type: 'body', metatype: CreateAuditEventDto }),
    ).rejects.toThrow();
  });

  it('rejects a body with a non-object payload', async () => {
    const body = { ...validBody(), payload: 'not an object' };
    await expect(
      pipe.transform(body, { type: 'body', metatype: CreateAuditEventDto }),
    ).rejects.toThrow();
  });

  it('rejects a body with a non-UUID companyId', async () => {
    const body = { ...validBody(), companyId: 'not-a-uuid' };
    await expect(
      pipe.transform(body, { type: 'body', metatype: CreateAuditEventDto }),
    ).rejects.toThrow();
  });

  it('strips genuinely unknown extra properties', async () => {
    const body = { ...validBody(), extraneous: 'should be dropped' };
    const result = (await pipe.transform(body, {
      type: 'body',
      metatype: CreateAuditEventDto,
    })) as CreateAuditEventDto & { extraneous?: string };

    expect(result.extraneous).toBeUndefined();
    expect(result.companyId).toBe(body.companyId);
  });
});
