import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { FormattingIcon } from '../api/models';
import type { PathArray } from '../../shared/components/json-tree/formatting-beacons-index';

/**
 * Cross-pane navigation state for beacon pills + ancestor badges.
 *
 * The toolbar's beacon-pills component lives outside the panes and
 * does not know whether the user has the editor or the tree focused.
 * We track the **last interacted pane** explicitly here -- updated on
 * Monaco cursor moves and on tree pointerdown / selection change --
 * so a pill click can dispatch the jump to the right pane in `split`
 * mode without sampling `document.activeElement` (which always points
 * at the pill button after click and is therefore unreliable for
 * this purpose).
 *
 * The pill component emits jump intents through `jumpRequest$`; the
 * `home` component subscribes and translates each request into a
 * tree expand+scroll or an editor `revealRange` based on the current
 * `paneVisibility()` and (in `split` mode) `lastActivePane`.
 */
export interface BeaconJumpRequest {
  readonly path: PathArray;
  readonly icon: FormattingIcon;
  readonly source: 'pill' | 'badge';
}

@Injectable({ providedIn: 'root' })
export class BeaconNavigationService {
  /**
   * Last pane the user interacted with. Default `'tree'` because in
   * `split` mode (the most common layout) tree-first feels closer to
   * what users expect when they have not yet touched either pane.
   */
  readonly lastActivePane = signal<'tree' | 'editor'>('tree');

  /**
   * Stream of jump requests. The home component subscribes once in
   * its constructor (via `takeUntilDestroyed`) and dispatches by
   * pane visibility + `lastActivePane`.
   */
  readonly jumpRequest$ = new Subject<BeaconJumpRequest>();

  /** Mark the editor as the most-recently active pane. */
  markEditorActive(): void {
    this.lastActivePane.set('editor');
  }

  /** Mark the tree as the most-recently active pane. */
  markTreeActive(): void {
    this.lastActivePane.set('tree');
  }

  /**
   * Convenience for the pill / badge components: emit a jump request
   * without exposing the raw Subject. Callers do NOT update
   * `lastActivePane` themselves -- the home dispatcher reads the
   * value captured BEFORE the click shifted focus.
   */
  requestJump(request: BeaconJumpRequest): void {
    this.jumpRequest$.next(request);
  }
}
