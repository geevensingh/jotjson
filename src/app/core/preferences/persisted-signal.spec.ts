import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { persistedSignal, persistedStringSignal } from './persisted-signal';

const STRING_KEY = 'jotjson.test.persistedString.v1';
const NUMBER_KEY = 'jotjson.test.persistedNumber.v1';

@Component({ standalone: true, template: '' })
class StringHost {
  readonly value = persistedStringSignal(STRING_KEY);
}

@Component({ standalone: true, template: '' })
class NumberHost {
  readonly value = persistedSignal<number>({
    key: NUMBER_KEY,
    defaultValue: 0.5,
    parse: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0.5;
      return Math.min(0.9, Math.max(0.1, n));
    },
    serialize: (n) => String(n),
  });
}

function makeStringHost(): StringHost {
  TestBed.resetTestingModule();
  const fixture = TestBed.configureTestingModule({}).createComponent(StringHost);
  fixture.detectChanges();
  return fixture.componentInstance;
}

function makeNumberHost(): NumberHost {
  TestBed.resetTestingModule();
  const fixture = TestBed.configureTestingModule({}).createComponent(NumberHost);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('persistedStringSignal', () => {
  beforeEach(() => localStorage.removeItem(STRING_KEY));
  afterEach(() => localStorage.removeItem(STRING_KEY));

  it('uses the default value when storage is empty', () => {
    const host = makeStringHost();
    expect(host.value()).toBe('');
  });

  it('hydrates from localStorage on construction', () => {
    localStorage.setItem(STRING_KEY, 'seed');
    const host = makeStringHost();
    expect(host.value()).toBe('seed');
  });

  it('writes through to localStorage on update', () => {
    const host = makeStringHost();
    host.value.set('alpha');
    TestBed.flushEffects();
    expect(localStorage.getItem(STRING_KEY)).toBe('alpha');
  });

  it('removes the storage key when the value is cleared to empty', () => {
    localStorage.setItem(STRING_KEY, 'seed');
    const host = makeStringHost();
    host.value.set('');
    TestBed.flushEffects();
    expect(localStorage.getItem(STRING_KEY)).toBeNull();
  });

  it('tolerates localStorage.setItem throwing', () => {
    const host = makeStringHost();
    spyOn(Storage.prototype, 'setItem').and.throwError('quota');
    expect(() => {
      host.value.set('alpha');
      TestBed.flushEffects();
    }).not.toThrow();
    expect(host.value()).toBe('alpha');
  });

  it('tolerates localStorage.getItem throwing on hydrate', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    const host = makeStringHost();
    expect(host.value()).toBe('');
  });
});

describe('persistedSignal (numeric)', () => {
  beforeEach(() => localStorage.removeItem(NUMBER_KEY));
  afterEach(() => localStorage.removeItem(NUMBER_KEY));

  it('uses the default value when storage is empty', () => {
    const host = makeNumberHost();
    expect(host.value()).toBe(0.5);
  });

  it('hydrates and clamps a stored value via parse', () => {
    localStorage.setItem(NUMBER_KEY, '0.02');
    const host = makeNumberHost();
    expect(host.value()).toBe(0.1);
  });

  it('falls back to default when parse decides the raw value is unusable', () => {
    localStorage.setItem(NUMBER_KEY, 'not-a-number');
    const host = makeNumberHost();
    expect(host.value()).toBe(0.5);
  });

  it('writes through to localStorage on update', () => {
    const host = makeNumberHost();
    host.value.set(0.75);
    TestBed.flushEffects();
    expect(localStorage.getItem(NUMBER_KEY)).toBe('0.75');
  });

  it('does not remove the key on numeric updates (no shouldRemove)', () => {
    const host = makeNumberHost();
    host.value.set(0.0);
    TestBed.flushEffects();
    expect(localStorage.getItem(NUMBER_KEY)).toBe('0');
  });
});
