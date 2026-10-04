import * as Joi from 'joi';
import { CapAction, PROVIDER_CATALOGUE } from '@tcp/shared';

/** A cap's measurement window. `month`/`week`/`day` are UTC calendar periods; `<N>h` is a stint starting at first use. */
export type CapPeriod = 'month' | 'week' | 'day' | `${number}h`;

/** One token ceiling within a {@link ProviderCap}. */
export interface CapLimit {
  tokens: number;
  per: CapPeriod;
}

/** A provider's configured caps: every limit that applies, when to notify, and what to do when reached. */
export interface ProviderCap {
  limits: CapLimit[];
  notifyAt: number[];
  action: CapAction;
}

/** Validated SPEND_CAPS: provider catalogue id → its cap. Empty when unset. */
export type SpendCaps = Record<string, ProviderCap>;

/** `month`/`week`/`day`, or a positive stint length like `5h`. */
const CAP_PERIOD_PATTERN = /^(month|week|day|[1-9]\d*h)$/;

const capLimitSchema = Joi.object({
  tokens: Joi.number().integer().positive().required(),
  per: Joi.string().pattern(CAP_PERIOD_PATTERN).required(),
});

const providerCapSchema = Joi.object({
  limits: Joi.array().items(capLimitSchema).min(1).required(),
  /** Percentages below 100 that raise a warning notification. Reaching 100% always notifies. */
  notifyAt: Joi.array()
    .items(Joi.number().integer().min(1).max(99))
    .unique()
    .default([80]),
  action: Joi.string()
    .valid('pause', 'finish-agents', 'finish-tasks')
    .default('pause'),
});

/** Keyed by provider catalogue id; an id outside the catalogue fails boot. */
const spendCapsObjectSchema = Joi.object<SpendCaps>().pattern(
  Joi.string().valid(...PROVIDER_CATALOGUE.map((provider) => provider.id)),
  providerCapSchema,
);

/**
 * Validates the raw SPEND_CAPS env string: parses it as JSON, then checks it
 * against the provider catalogue and each cap's shape. Unset or empty (compose
 * passes an unset variable as '') defaults to {} (no caps) without running the
 * parser — Joi never runs a schema's rules on a defaulted value. Boot fails on
 * bad JSON or an invalid cap.
 */
export const spendCapsSchema: Joi.Schema = Joi.string()
  .empty('')
  .custom((value: string, helpers) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return helpers.message({ custom: 'SPEND_CAPS is not valid JSON' });
    }
    const result = spendCapsObjectSchema.validate(parsed);
    if (result.error) {
      return helpers.message({ custom: `SPEND_CAPS ${result.error.message}` });
    }
    return result.value;
  })
  .default({});
