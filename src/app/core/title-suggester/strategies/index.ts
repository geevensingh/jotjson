import type { SuggestionStrategy } from '../types';
import { filenameStrategy } from './filename';
import { packageJsonStrategy } from './package-json';
import { kubernetesStrategy } from './kubernetes';
import { openapiStrategy } from './openapi';
import { jsonSchemaStrategy } from './json-schema';
import { geojsonStrategy } from './geojson';
import { armTemplateStrategy } from './arm-template';
import { tsconfigStrategy } from './tsconfig';
import { githubActionsWorkflowStrategy } from './github-actions-workflow';
import { postmanCollectionStrategy } from './postman-collection';
import { selfUrlStrategy } from './self-url';
import { namedFieldStrategy } from './named-field';
import { typeFieldStrategy } from './type-field';
import { topLevelKeysStrategy } from './top-level-keys';
import { descriptionFallbackStrategy } from './description-fallback';
import { arrayShapeStrategy } from './array-shape';
import { objectShapeStrategy } from './object-shape';
import { primitiveStrategy } from './primitive';
import { firstCharsStrategy } from './first-chars';
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
