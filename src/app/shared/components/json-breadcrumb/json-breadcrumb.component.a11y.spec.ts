import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { type BreadcrumbCrumb, JsonBreadcrumbComponent } from './json-breadcrumb.component';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../../../../testing/a11y';

const REPRESENTATIVE_CRUMBS: readonly BreadcrumbCrumb[] = [
  { label: '$', canonicalPath: '$', current: false },
  { label: 'profile', canonicalPath: '$.profile', current: false },
  { label: 'displayName', canonicalPath: '$.profile.displayName', current: true },
];

describe('JsonBreadcrumbComponent (a11y)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonBreadcrumbComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  function createPopulatedFixture(): ComponentFixture<JsonBreadcrumbComponent> {
    const fixture = TestBed.createComponent(JsonBreadcrumbComponent);
    fixture.componentRef.setInput('crumbs', REPRESENTATIVE_CRUMBS);
    fixture.componentRef.setInput('navAriaLabel', 'JSON path breadcrumb');
    fixture.componentRef.setInput('overflowAriaLabel', 'Show hidden ancestors');
    fixture.componentRef.setInput('copyPathTitle', 'Copy JSON path');
    fixture.componentRef.setInput('copyPathAriaLabel', 'Copy JSON path of selected row');
    fixture.componentRef.setInput('copyPathDisabled', false);
    return fixture;
  }

  function createEmptyFixture(): ComponentFixture<JsonBreadcrumbComponent> {
    const fixture = TestBed.createComponent(JsonBreadcrumbComponent);
    fixture.componentRef.setInput('emptyPlaceholder', 'Select a tree row to show its path');
    fixture.componentRef.setInput('copyPathDisabled', true);
    return fixture;
  }

  it('has no critical or serious WCAG 2.1 AA violations when populated (dark theme)', async () => {
    const fixture = createPopulatedFixture();
    teardown = attachFixtureToBody(fixture, 'dark');

    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations when populated (light theme)', async () => {
    const fixture = createPopulatedFixture();
    teardown = attachFixtureToBody(fixture, 'light');

    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations when empty (dark theme)', async () => {
    const fixture = createEmptyFixture();
    teardown = attachFixtureToBody(fixture, 'dark');

    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations when empty (light theme)', async () => {
    const fixture = createEmptyFixture();
    teardown = attachFixtureToBody(fixture, 'light');

    await expectNoStrictA11yViolations(fixture);
  });
});
