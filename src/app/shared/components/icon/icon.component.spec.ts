import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IconComponent, JjIconName } from './icon.component';

@Component({
  standalone: true,
  imports: [IconComponent],
  template: `<div style="font-size: 8px"><jj-icon name="sun" size="auto" /></div>`,
})
class AutoSizeHostComponent {}

describe('IconComponent', () => {
  const allIcons = [
    'paste',
    'copy',
    'upload',
    'download',
    'format',
    'minify',
    'clear',
    'layout-horizontal',
    'layout-vertical',
    'sun',
    'moon',
    'system',
    'copy-path',
    'chevron-right',
    'chevron-down',
    'sign-in',
    'sign-out',
    'save',
    'more-vert',
    'more-horiz',
    'link',
    'arrows-exchange',
    'arrows-exchange-off',
    'pane-both',
    'pane-left-only',
    'pane-right-only',
    'pane-stacked',
    'globe',
    'lock',
    'trash',
    'edit',
    'eye',
    'eye-off',
    'folder',
    'history',
    'search',
    'warning',
    'check',
    'star',
    'info',
    'error',
    'flag',
    'bookmark',
    'extract',
    'decoded',
    'wand',
    'key',
    'collapse-subtree',
    'expand-subtree',
    'isolate',
    'subtree',
  ] as const satisfies readonly JjIconName[];

  async function createWith(name: JjIconName): Promise<ComponentFixture<IconComponent>> {
    await TestBed.configureTestingModule({ imports: [IconComponent] }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', name);
    fixture.detectChanges();
    return fixture;
  }

  function getSvg(fixture: ComponentFixture<IconComponent>): SVGElement {
    const svgElement = fixture.nativeElement.querySelector('svg') as SVGElement | null;
    if (svgElement === null) {
      throw new Error('Expected icon SVG to render');
    }
    return svgElement;
  }

  for (const name of allIcons) {
    it(`renders an SVG with at least one shape for "${name}"`, async () => {
      const fixture = await createWith(name);
      const svgElement = getSvg(fixture);
      const shapeCount = svgElement.querySelectorAll('path, rect, circle, line, polygon').length;
      expect(shapeCount).withContext(`${name} should render at least one shape`).toBeGreaterThan(0);
    });
  }

  it('honors the size input on width/height', async () => {
    await TestBed.configureTestingModule({ imports: [IconComponent] }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'sun');
    fixture.componentRef.setInput('size', 32);
    fixture.detectChanges();
    const svgElement = getSvg(fixture);
    expect(svgElement.getAttribute('width')).toBe('32');
    expect(svgElement.getAttribute('height')).toBe('32');
  });

  it('defaults to size 20 without auto sizing', async () => {
    const fixture = await createWith('moon');
    const hostElement = fixture.nativeElement as HTMLElement;
    const svgElement = getSvg(fixture);
    expect(svgElement.getAttribute('width')).toBe('20');
    expect(svgElement.getAttribute('height')).toBe('20');
    expect(hostElement.classList.contains('jj-icon--auto')).toBeFalse();
  });

  it('omits SVG dimensions and marks the host in auto mode', async () => {
    await TestBed.configureTestingModule({ imports: [IconComponent] }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'sun');
    fixture.componentRef.setInput('size', 'auto');
    fixture.detectChanges();
    const hostElement = fixture.nativeElement as HTMLElement;
    const svgElement = getSvg(fixture);
    expect(svgElement.hasAttribute('width')).toBeFalse();
    expect(svgElement.hasAttribute('height')).toBeFalse();
    expect(hostElement.classList.contains('jj-icon--auto')).toBeTrue();
  });

  it('sizes the host from the parent font size in auto mode', async () => {
    await TestBed.configureTestingModule({ imports: [AutoSizeHostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(AutoSizeHostComponent);
    fixture.detectChanges();
    const hostElement = fixture.nativeElement.querySelector('jj-icon') as HTMLElement | null;
    expect(hostElement).not.toBeNull();
    const hostStyle = getComputedStyle(hostElement!);
    expect(hostStyle.width).toBe('8px');
    expect(hostStyle.height).toBe('8px');
  });
});
