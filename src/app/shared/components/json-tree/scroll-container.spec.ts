import { findScrollableAncestor } from './scroll-container';

describe('findScrollableAncestor', () => {
  let attachedElements: HTMLElement[] = [];

  function attach(element: HTMLElement): HTMLElement {
    document.body.appendChild(element);
    attachedElements.push(element);
    return element;
  }

  afterEach(() => {
    for (const element of attachedElements) {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    }
    attachedElements = [];
  });

  it('returns null when no scroll ancestor exists', () => {
    // Use a detached subtree so the walk never reaches document.body
    // (Chrome reports body with overflow-y:auto in Karma's test page).
    const grandparent = document.createElement('div');
    grandparent.style.cssText = 'display: block; overflow-y: visible;';

    const parent = document.createElement('div');
    parent.style.cssText = 'display: block; overflow-y: visible;';

    const child = document.createElement('div');

    grandparent.appendChild(parent);
    parent.appendChild(child);
    // Intentionally NOT attached to document.body - walk stops at grandparent.

    expect(findScrollableAncestor(child)).toBeNull();
  });

  it('returns direct parent when it has overflow-y auto and positive clientHeight', () => {
    const parent = document.createElement('div');
    parent.style.cssText = 'overflow-y: auto; height: 200px;';

    const child = document.createElement('div');
    parent.appendChild(child);
    attach(parent);

    expect(findScrollableAncestor(child)).toBe(parent);
  });

  it('skips ancestors with matching overflow but zero clientHeight and finds the next measurable one', () => {
    const grandparent = document.createElement('div');
    grandparent.style.cssText = 'overflow-y: auto; height: 300px;';

    const parent = document.createElement('div');
    parent.style.cssText = 'overflow-y: auto; display: none;';

    const child = document.createElement('div');

    grandparent.appendChild(parent);
    parent.appendChild(child);
    attach(grandparent);

    // parent has overflow-y: auto but display:none => clientHeight === 0
    // grandparent has overflow-y: auto and positive clientHeight
    expect(findScrollableAncestor(child)).toBe(grandparent);
  });

  it('returns the nearest scroll ancestor when multiple exist in the chain', () => {
    const outerAncestor = document.createElement('div');
    outerAncestor.style.cssText = 'overflow-y: auto; height: 500px;';

    const innerAncestor = document.createElement('div');
    innerAncestor.style.cssText = 'overflow-y: auto; height: 200px;';

    const child = document.createElement('div');

    outerAncestor.appendChild(innerAncestor);
    innerAncestor.appendChild(child);
    attach(outerAncestor);

    expect(findScrollableAncestor(child)).toBe(innerAncestor);
  });

  it('matches overflow-y: scroll', () => {
    const parent = document.createElement('div');
    parent.style.cssText = 'overflow-y: scroll; height: 200px;';

    const child = document.createElement('div');
    parent.appendChild(child);
    attach(parent);

    expect(findScrollableAncestor(child)).toBe(parent);
  });

  it('does not match overflow-y: hidden', () => {
    // Use a detached subtree so the walk never reaches document.body
    // (Chrome reports body with overflow-y:auto in Karma's test page).
    const parent = document.createElement('div');
    parent.style.cssText = 'overflow-y: hidden; height: 200px;';

    const child = document.createElement('div');
    parent.appendChild(child);
    // Intentionally NOT attached to document.body - walk stops at parent.

    expect(findScrollableAncestor(child)).toBeNull();
  });

  it('returns null for a detached element without throwing', () => {
    const parent = document.createElement('div');
    const child = document.createElement('div');
    parent.appendChild(child);
    // Not attached to document.body - detached subtree

    expect(findScrollableAncestor(child)).toBeNull();
  });
});
