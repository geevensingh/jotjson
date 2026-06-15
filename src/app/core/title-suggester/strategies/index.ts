import type { SuggestionStrategy } from '../types';
import { applicationInsightsTelemetryStrategy } from './application-insights-telemetry';
import { armTemplateStrategy } from './arm-template';
import { arrayShapeStrategy } from './array-shape';
import { cloudEventStrategy } from './cloud-event';
import { descriptionFallbackStrategy } from './description-fallback';
import { eventEnvelopeStrategy } from './event-envelope';
import { filenameStrategy } from './filename';
import { firstCharsStrategy } from './first-chars';
import { geojsonStrategy } from './geojson';
import { githubActionsWorkflowStrategy } from './github-actions-workflow';
import { identifierFieldStrategy } from './identifier-field';
import { jsonSchemaStrategy } from './json-schema';
import { jwtPayloadStrategy } from './jwt-payload';
import { kubernetesStrategy } from './kubernetes';
import { microsoftCommerceBillingEventStrategy } from './microsoft-commerce-billing-event';
import { namedFieldStrategy } from './named-field';
import { objectShapeStrategy } from './object-shape';
import { openapiStrategy } from './openapi';
import { packageJsonStrategy } from './package-json';
import { postmanCollectionStrategy } from './postman-collection';
import { primitiveStrategy } from './primitive';
import { selfUrlStrategy } from './self-url';
import { topLevelKeysStrategy } from './top-level-keys';
import { tsconfigStrategy } from './tsconfig';
import { typeFieldStrategy } from './type-field';
import { untitledStrategy } from './untitled';

/**
 * Ordered registry of regular suggestion strategies. The order here
 * is documentation only -- the compose layer sorts by confidence
 * before deduping. Synthetic-floor strategies (`dateStamped`,
 * `numberedUntitled`) are NOT in this list; they are invoked by the
 * service only when the post-cap list is still under 2.
 *
 * ## Acceptance criterion for new vendor / domain recognizers
 *
 * Adding a new vendor- or domain-specific recognizer (e.g. for
 * Stripe webhooks, GitHub events, AWS CloudWatch alarms, Datadog
 * events, ...) requires ALL of:
 *
 *   1. The format has a tight multi-field structural witness
 *      (>= 3 stable discriminating fields, low false-positive rate
 *      against non-instances).
 *   2. The format is either (a) an open standard / RFC, or (b) a
 *      vendor format with documented high prevalence in real-world
 *      JSON traffic (e.g. a top-3 cloud vendor's webhook envelope,
 *      or a widely-cited telemetry / observability format).
 *   3. The strategy produces a title meaningfully better than what
 *      generic strategies (`namedField`, `typeField`, `eventEnvelope`,
 *      `identifierField`) would produce on the same input.
 *   4. The structural gate, output template, and at least one
 *      near-miss reject test are documented inline in the strategy
 *      file.
 *
 * Strategies that don't meet the bar should be expressed through
 * the generic `eventEnvelope` composite or one of the existing
 * field-based strategies instead.
 */
export const STRATEGIES: readonly SuggestionStrategy[] = [
  filenameStrategy,
  packageJsonStrategy,
  kubernetesStrategy,
  openapiStrategy,
  jsonSchemaStrategy,
  geojsonStrategy,
  armTemplateStrategy,
  tsconfigStrategy,
  githubActionsWorkflowStrategy,
  postmanCollectionStrategy,
  cloudEventStrategy,
  jwtPayloadStrategy,
  microsoftCommerceBillingEventStrategy,
  applicationInsightsTelemetryStrategy,
  eventEnvelopeStrategy,
  selfUrlStrategy,
  identifierFieldStrategy,
  namedFieldStrategy,
  typeFieldStrategy,
  topLevelKeysStrategy,
  descriptionFallbackStrategy,
  arrayShapeStrategy,
  objectShapeStrategy,
  primitiveStrategy,
  firstCharsStrategy,
  untitledStrategy,
];
