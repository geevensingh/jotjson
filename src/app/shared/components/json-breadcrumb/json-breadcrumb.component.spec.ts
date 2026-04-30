import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import {
  BreadcrumbClick,
  BreadcrumbCrumb,
  JsonBreadcrumbComponent
} from './json-breadcrumb.component';

describe('JsonBreadcrumbComponent', () => {
  async function createWith(
    crumbs: readonly BreadcrumbCrumb[],
    opts: {
      emptyPlaceholder?: string;
      navAriaLabel?: string;
      overflowAriaLabel?: string;
    } = {}
  ): Promise<ComponentFixture<JsonBreadcrumbComponent>> {
    await TestBed.configureTestingModule({
      imports: [JsonBreadcrumbComponent, NoopAnimationsModule]
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonBreadcrumbComponent);
    fixture.componentRef.setInput('crumbs', crumbs);
    if (opts.emptyPlaceholder !== undefined) {
      fixture.componentRef.setInput('emptyPlaceholder', opts.emptyPlaceholder);
    }
    if (opts.navAriaLabel !== undefined) {
      fixture.componentRef.setInput('navAriaLabel', opts.navAriaLabel);
    }
    if (opts.overflowAriaLabel !== undefined) {
      fixture.componentRef.setInput('overflowAriaLabel', opts.overflowAriaLabel);
    }
    fixture.detectChanges();
    return fixture;
  }

  function makeCrumbs(count: number): BreadcrumbCrumb[] {
    const out: BreadcrumbCrumb[] = [];
    for (let index = 0; index < count; index++) {
      out.push({
        label: `crumb${index}`,
        canonicalPath: `$.crumb${index}`
      });
    }
    return out;
  }

  function chipButtons(fixture: ComponentFixture<JsonBreadcrumbComponent>): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.jj-breadcrumb__chip')
    ) as HTMLButtonElement[];
  }

  it('renders the placeholder when crumbs is empty', async () => {
    const fixture = await createWith([], {
      emptyPlaceholder: 'No current selection'
    });
    const empty = fixture.nativeElement.querySelector(
      '.jj-breadcrumb--empty'
    ) as HTMLElement | null;
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe('No current selection');
    expect(empty?.getAttribute('aria-live')).toBe('polite');
    expect(chipButtons(fixture).length).toBe(0);
  });

  it('renders a single chip when one crumb is provided', async () => {
    const fixture = await createWith([
      { label: 'Root', canonicalPath: '$' }
    ]);
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(1);
    expect(chips[0].textContent?.trim()).toBe('Root');
    const overflow = fixture.nativeElement.querySelector(
      '.jj-breadcrumb__chip--overflow'
    );
    expect(overflow).toBeNull();
  });

  it('renders all chips inline when count is exactly 5', async () => {
    const fixture = await createWith(makeCrumbs(5));
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(5);
    const overflow = fixture.nativeElement.querySelector(
      '.jj-breadcrumb__chip--overflow'
    );
    expect(overflow).toBeNull();
  });

  it('collapses to leading + overflow + trailing when count is 6', async () => {
    const fixture = await createWith(makeCrumbs(6));
    const chips = chipButtons(fixture);
    // 2 leading + 1 overflow + 2 trailing = 5 visible
    expect(chips.length).toBe(5);
    const labels = chips.map((b) => b.textContent?.trim());
    expect(labels).toEqual(['crumb0', 'crumb1', '...', 'crumb4', 'crumb5']);
  });

  it('collapses correctly when count is 10', async () => {
    const fixture = await createWith(makeCrumbs(10));
    const chips = chipButtons(fixture);
    expect(chips.length).toBe(5);
    const labels = chips.map((b) => b.textContent?.trim());
    expect(labels).toEqual(['crumb0', 'crumb1', '...', 'crumb8', 'crumb9']);
  });

  it('emits crumbClick with absolute depth when a leading chip is clicked', async () => {
    const fixture = await createWith(makeCrumbs(8));
    const events: BreadcrumbClick[] = [];
    fixture.componentInstance.crumbClick.subscribe((value) => {
      events.push(value);
    });
    const chips = chipButtons(fixture);
    chips[1].click();
    expect(events).toEqual([{ canonicalPath: '$.crumb1', depth: 1 }]);
  });

  it('emits crumbClick with absolute depth when a trailing chip is clicked', async () => {
    const fixture = await createWith(makeCrumbs(8));
    const events: BreadcrumbClick[] = [];
    fixture.componentInstance.crumbClick.subscribe((value) => {
      events.push(value);
    });
    const chips = chipButtons(fixture);
    // chips[4] is the last trailing, which is crumbs[7]
    chips[4].click();
    expect(events).toEqual([{ canonicalPath: '$.crumb7', depth: 7 }]);
  });

  it('exposes hidden middle ancestors via the hiddenCrumbs computed', async () => {
    const fixture = await createWith(makeCrumbs(8));
    const hidden = fixture.componentInstance.hiddenCrumbs();
    expect(hidden.map((crumb) => crumb.canonicalPath)).toEqual([
      '$.crumb2',
      '$.crumb3',
      '$.crumb4',
      '$.crumb5'
    ]);
  });

  it('does not render aria-current on any chip', async () => {
    const fixture = await createWith(makeCrumbs(3));
    const chips = chipButtons(fixture);
    for (const chip of chips) {
      expect(chip.hasAttribute('aria-current')).toBe(false);
    }
  });

  it('uses the supplied nav aria-label', async () => {
    const fixture = await createWith(makeCrumbs(2), {
      navAriaLabel: 'Migas de pan'
    });
    const nav = fixture.nativeElement.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('Migas de pan');
  });
});
