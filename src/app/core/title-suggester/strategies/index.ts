import type { SuggestionStrategy } from '../types';
import { armTemplateStrategy } from './arm-template';
import { arrayShapeStrategy } from './array-shape';
import { descriptionFallbackStrategy } from './description-fallback';
import { filenameStrategy } from './filename';
import { firstCharsStrategy } from './first-chars';
import { geojsonStrategy } from './geojson';
import { githubActionsWorkflowStrategy } from './github-actions-workflow';
import { jsonSchemaStrategy } from './json-schema';
import { kubernetesStrategy } from './kubernetes';
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
  selfUrlStrategy,
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
