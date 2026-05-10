import { Component, viewChild } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { CloseMatMenuOnWindowBlurDirective } from './close-mat-menu-on-window-blur.directive';

@Component({
  standalone: true,
  imports: [MatMenuModule, CloseMatMenuOnWindowBlurDirective],
  template: `
    <button #trigger="matMenuTrigger" type="button" [matMenuTriggerFor]="menu">Open</button>
    <mat-menu #menu="matMenu">
      <button mat-menu-item type="button">Item</button>
    </mat-menu>
  `,
})
class TestHostComponent {
  readonly trigger = viewChild.required<MatMenuTrigger>('trigger');
}

describe('CloseMatMenuOnWindowBlurDirective', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [provideNoopAnimations()],
    });
  });

  it('closes the open menu on window.blur and returns focus to the trigger', fakeAsync(() => {
    const fixture = TestBed.createComponent(TestHostComponent);
    const teardown = attachToBody(fixture);
    const trigger = fixture.componentInstance.trigger;

    try {
      fixture.detectChanges();
      const triggerButton = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
      triggerButton.focus();
      openMenu(fixture, trigger());

      window.dispatchEvent(new Event('blur'));
      flushMenu(fixture);

      expect(trigger().menuOpen).toBeFalse();
      expect(document.activeElement).toBe(triggerButton);
    } finally {
      teardown();
    }
  }));

  it('is a no-op when window.blur fires while no menu is open', fakeAsync(() => {
    const fixture = TestBed.createComponent(TestHostComponent);
    const trigger = fixture.componentInstance.trigger;
    const warnSpy = spyOn(console, 'warn');

    fixture.detectChanges();

    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
    flushMenu(fixture);

    expect(trigger().menuOpen).toBeFalse();
    expect(warnSpy).not.toHaveBeenCalled();
  }));

  it('removes the listener after the menu closes via item selection', fakeAsync(() => {
    const addSpy = spyOn(window, 'addEventListener').and.callThrough();
    const removeSpy = spyOn(window, 'removeEventListener').and.callThrough();
    const fixture = TestBed.createComponent(TestHostComponent);
    const trigger = fixture.componentInstance.trigger;

    fixture.detectChanges();
    openMenu(fixture, trigger());
    const handlerRef = getBlurHandler(addSpy);

    clickMenuItem();
    flushMenu(fixture);

    expect(trigger().menuOpen).toBeFalse();
    expect(findBlurRemoveCall(removeSpy, handlerRef)).toBeDefined();
  }));

  it('removes the listener when the directive is destroyed mid-open', fakeAsync(() => {
    const addSpy = spyOn(window, 'addEventListener').and.callThrough();
    const removeSpy = spyOn(window, 'removeEventListener').and.callThrough();
    const fixture = TestBed.createComponent(TestHostComponent);
    const trigger = fixture.componentInstance.trigger;

    fixture.detectChanges();
    openMenu(fixture, trigger());
    const handlerRef = getBlurHandler(addSpy);

    fixture.destroy();

    expect(findBlurRemoveCall(removeSpy, handlerRef)).toBeDefined();
  }));
});

function attachToBody(fixture: ComponentFixture<unknown>): () => void {
  document.body.appendChild(fixture.nativeElement);
  return () => {
    fixture.nativeElement.remove();
  };
}

function openMenu(fixture: ComponentFixture<TestHostComponent>, trigger: MatMenuTrigger): void {
  trigger.openMenu();
  flushMenu(fixture);
  expect(trigger.menuOpen).toBeTrue();
}

function flushMenu(fixture: ComponentFixture<TestHostComponent>): void {
  fixture.detectChanges();
  tick(0);
  fixture.detectChanges();
}

function clickMenuItem(): void {
  const menuItem = document.querySelector<HTMLButtonElement>('button[mat-menu-item]');
  expect(menuItem).not.toBeNull();

  if (!menuItem) {
    throw new Error('Expected rendered mat-menu-item.');
  }

  menuItem.click();
}

function getBlurHandler(addSpy: jasmine.Spy): EventListenerOrEventListenerObject {
  const blurAddCall = addSpy.calls.allArgs().find(([type]) => type === 'blur');
  expect(blurAddCall).toBeDefined();

  if (!blurAddCall) {
    throw new Error('Expected window.addEventListener to be called for blur.');
  }

  return blurAddCall[1];
}

function findBlurRemoveCall(
  removeSpy: jasmine.Spy,
  handlerRef: EventListenerOrEventListenerObject,
): unknown[] | undefined {
  return removeSpy.calls
    .allArgs()
    .find(([type, listener]) => type === 'blur' && listener === handlerRef);
}
