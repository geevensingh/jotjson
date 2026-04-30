import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IconComponent, JjIconName } from './icon.component';

describe('IconComponent', () => {
  const allIcons: JjIconName[] = [
    'paste',
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
    'link',
    'arrows-exchange',
    'arrows-exchange-off',
    'pane-both',
    'pane-left-only',
    'pane-right-only',
    'pane-stacked',
    'warning',
    'check',
    'star',
    'info',
    'error',
    'flag',
    'bookmark'
  ];

  async function createWith(name: JjIconName): Promise<ComponentFixture<IconComponent>> {
    await TestBed.configureTestingModule({ imports: [IconComponent] }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', name);
    fixture.detectChanges();
    return fixture;
  }

  for (const name of allIcons) {
    it(`renders an SVG with at least one shape for "${name}"`, async () => {
      const fixture = await createWith(name);
      const svg = fixture.nativeElement.querySelector('svg') as SVGElement | null;
      expect(svg).withContext(`svg missing for ${name}`).not.toBeNull();
      const shapeCount = svg!.querySelectorAll('path, rect, circle, line, polygon').length;
      expect(shapeCount)
        .withContext(`${name} should render at least one shape`)
        .toBeGreaterThan(0);
    });
  }

  it('honors the size input on width/height', async () => {
    await TestBed.configureTestingModule({ imports: [IconComponent] }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'sun');
    fixture.componentRef.setInput('size', 32);
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
  });

  it('defaults to size 20', async () => {
    const fixture = await createWith('moon');
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('width')).toBe('20');
  });
});
