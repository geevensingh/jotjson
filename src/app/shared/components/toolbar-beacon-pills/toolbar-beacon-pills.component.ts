import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { FormattingIcon } from '../../../core/api/models';
import { LoggerService } from '../../../core/telemetry/logger.service';
import {
  BeaconNavigationService,
  type BeaconJumpRequest,
} from '../../../core/beacons/beacon-navigation.service';
import {
  EMPTY_BEACON_INDEX,
  type BeaconIndex,
  type PathArray,
} from '../json-tree/formatting-beacons-index';
import { IconComponent } from '../icon/icon.component';

/**
 * Toolbar beacon pills: one pill per icon-bucket that has at least
 * one match in the current tree. Clicking a pill cycles forward to
 * the next match for that icon; Shift+click cycles backward. The
 * cursor is per-icon and clamps when a bucket shrinks (e.g., the
 * underlying tree was edited so fewer nodes match).
 *
 * The pill component is purely a presentation+navigation widget: it
 * does not select tree nodes or scroll Monaco directly. It dispatches
 * jump intents through `BeaconNavigationService.jumpRequest$` and the
 * home component's cross-pane dispatcher decides which pane handles
 * the jump based on `paneVisibility` + `lastActivePane`.
 */
@Component({
  selector: 'jj-toolbar-beacon-pills',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, MatTooltipModule],
  templateUrl: './toolbar-beacon-pills.component.html',
  styleUrl: './toolbar-beacon-pills.component.scss',
})
export class ToolbarBeaconPillsComponent {
  private readonly logger = inject(LoggerService);
  private readonly beaconNav = inject(BeaconNavigationService);

  /** Current beacon index from the tree; identity-shared empty when no matches. */
  readonly beaconIndex = input<BeaconIndex>(EMPTY_BEACON_INDEX);

  /**
   * Per-icon cursor (next-match index in that icon's bucket). Maps
   * icon -> 0-based pointer. Clamped on bucket shrink via the
   * `clampCursors` effect.
   */
  private readonly cursorByIcon = signal<ReadonlyMap<FormattingIcon, number>>(
    new Map<FormattingIcon, number>(),
  );

  /**
   * Stable, pre-order iteration over the icon-buckets present in the
   * current index. The helper guarantees pre-order tree-walk for
   * matchesByIcon, so iteration order here mirrors that.
   */
  readonly buckets = computed<readonly PillBucket[]>(() => {
    const index = this.beaconIndex();
    if (index === EMPTY_BEACON_INDEX) return [];
    const out: PillBucket[] = [];
    for (const [icon, paths] of index.matchesByIcon.entries()) {
      if (paths.length === 0) continue;
      out.push({ icon, paths });
    }
    return out;
  });

  constructor() {
    // When the index changes, clamp every per-icon cursor into its
    // (now possibly shrunk) bucket. Drops cursors for icons that are
    // no longer present so the map does not leak stale entries.
    effect(() => {
      const buckets = this.buckets();
      const previous = untracked(() => this.cursorByIcon());
      const next = new Map<FormattingIcon, number>();
      for (const bucket of buckets) {
        const old = previous.get(bucket.icon) ?? 0;
        next.set(bucket.icon, Math.min(old, bucket.paths.length - 1));
      }
      // Skip the write when the map is structurally identical, to
      // avoid feedback loops.
      if (mapsEqual(previous, next)) return;
      this.cursorByIcon.set(next);
    });
  }

  /** Tooltip / aria text for a pill. */
  pillTooltip(bucket: PillBucket): string {
    const icon = bucket.icon;
    const count = bucket.paths.length;
    return count === 1
      ? $localize`:@@toolbar.beacon.pill.tooltip.single:Jump to ${icon}:icon: beacon`
      : $localize`:@@toolbar.beacon.pill.tooltip.many:Jump to next of ${count}:count: ${icon}:icon: beacons (Shift+click for previous)`;
  }

  /** Click handler: forward by default, backward with Shift. */
  onPillClick(bucket: PillBucket, event: MouseEvent): void {
    event.stopPropagation();
    const direction: 'forward' | 'backward' = event.shiftKey ? 'backward' : 'forward';
    const length = bucket.paths.length;
    if (length === 0) return;
    const cursors = this.cursorByIcon();
    const current = cursors.get(bucket.icon) ?? 0;
    const target =
      direction === 'forward' ? (current + 1) % length : (current - 1 + length) % length;
    const next = new Map(cursors);
    next.set(bucket.icon, target);
    this.cursorByIcon.set(next);
    this.logger.info('beacons.pill.clicked', {
      icon: bucket.icon,
      direction,
      bucketSize: length,
    });
    const path = bucket.paths[target];
    if (path === undefined) return;
    const request: BeaconJumpRequest = {
      path,
      icon: bucket.icon,
      source: 'pill',
    };
    this.beaconNav.requestJump(request);
  }
}

interface PillBucket {
  readonly icon: FormattingIcon;
  readonly paths: readonly PathArray[];
}

function mapsEqual<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    if (b.get(key) !== value) return false;
  }
  return true;
}
