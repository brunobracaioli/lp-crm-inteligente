import { describe, expectTypeOf, it } from 'vitest';
import type {
  ConversionDestinationName,
  DeliveryAttemptResult,
  DeliveryStatus as PortDeliveryStatus,
  LeadConversionSource,
} from '#/modules/tracking/application/ports.ts';
import type { AttemptOutcome } from '#/modules/tracking/domain/delivery.ts';
import type { LeadConversionFacts } from '#/modules/tracking/domain/conversion-event.ts';
import type { DeliveryStatus, Destination } from '#/modules/tracking/domain/destinations.ts';

/**
 * `domain/` may not import the application ports, so it re-declares a few shapes. These
 * compile-time assertions (checked by `pnpm typecheck`) keep the copies structurally in sync with
 * the frozen ports; `it` only satisfies the test runner.
 */
describe('domain vocabularies stay in sync with the frozen ports', () => {
  it('destinations and delivery statuses are identical to the port unions', () => {
    expectTypeOf<Destination>().toEqualTypeOf<ConversionDestinationName>();
    expectTypeOf<DeliveryStatus>().toEqualTypeOf<PortDeliveryStatus>();
  });

  it('the port source and attempt result are accepted by the domain inputs', () => {
    expectTypeOf<LeadConversionSource>().toExtend<LeadConversionFacts>();
    expectTypeOf<DeliveryAttemptResult>().toExtend<AttemptOutcome>();
  });
});
