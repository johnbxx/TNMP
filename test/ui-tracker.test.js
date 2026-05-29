import { describe, it, expect, afterEach } from 'vitest';
import { renderRoundTracker } from '../src/ui.js';
import { STATE } from '../src/config.js';

// The test env is `node` (no DOM), so we supply a tiny faithful DOM covering
// exactly the selectors/mutations renderRoundTracker uses. This reproduces the
// real production crash: the round tracker selected the opponent button by its
// `.opponent-link` class, but the bye branch *removes* that class for styling —
// so any re-render after a bye rendered once couldn't re-find the button and
// threw "Cannot set properties of null (setting 'textContent')".

class ClassList {
    constructor(el) { this.el = el; }
    add(...c) { c.forEach((x) => this.el._classes.add(x)); }
    remove(...c) { c.forEach((x) => this.el._classes.delete(x)); }
    contains(c) { return this.el._classes.has(c); }
    toggle(c, f) { if (f) this.el._classes.add(c); else this.el._classes.delete(c); }
}

class El {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this._classes = new Set();
        this.attrs = {};
        this.children = [];
        this._text = '';
        this.dataset = {};
        this.classList = new ClassList(this);
        this.addEventListener = () => {};
    }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    set textContent(v) { this._text = v; }
    get textContent() { return this._text; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html; }
    setAttribute(k, v) {
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
        this.attrs[k] = v;
    }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    toggleAttribute(k, f) { if (f) this.attrs[k] = ''; else delete this.attrs[k]; }
    append(c) { c.parent = this; this.children.push(c); }
    _all() {
        const out = [];
        const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    _matches(sel) {
        const m = sel.match(/^\.([\w-]+)(?:\[data-([\w-]+)="([^"]+)"\])?$/);
        if (!m) return false;
        if (!this._classes.has(m[1])) return false;
        if (m[2] !== undefined && this.dataset[m[2].replace(/-(\w)/g, (_, c) => c.toUpperCase())] !== m[3]) return false;
        return true;
    }
    querySelector(sel) {
        const parts = sel.trim().split(/\s+/);
        if (parts.length === 1) return this._all().find((e) => e._matches(parts[0])) || null;
        const [a, b] = parts; // e.g. ".pairing-opponent button"
        for (const anc of this._all()) {
            if (!anc._matches(a)) continue;
            const hit = anc._all().find((e) => (b === 'button' ? e.tagName === 'BUTTON' : e._matches(b)));
            if (hit) return hit;
        }
        return null;
    }
}

// Mirrors index.html's tracker markup (7 round tabs + detail panels).
function buildTrackerDom() {
    const root = new El('div');
    const section = new El('div'); section.attrs.id = 'tracker-section';
    const container = new El('div'); container.attrs.id = 'round-tracker';
    root.append(section); root.append(container);
    for (let i = 1; i <= 7; i++) {
        const tab = new El('button'); tab.className = 'tracker-round'; tab.setAttribute('data-round', String(i)); container.append(tab);
        const panel = new El('div'); panel.className = 'tracker-detail'; panel.setAttribute('data-round', String(i)); container.append(panel);
        panel.append(Object.assign(new El('div'), { className: 'pairing-history-label' }));
        const res = new El('div'); res.className = 'pairing-result'; panel.append(res);
        const opp = new El('div'); opp.className = 'pairing-opponent'; panel.append(opp);
        const img = new El('img'); img.className = 'color-icon'; opp.append(img);
        const btn = new El('button'); btn.className = 'opponent-link'; btn.setAttribute('data-action', 'open-profile'); opp.append(btn);
        const vg = new El('button'); vg.className = 'view-game-btn'; vg.setAttribute('data-action', 'view-tracker-game'); panel.append(vg);
    }
    return root;
}

function findPanel(root, round) {
    return root._all().find((e) => e._classes.has('tracker-detail') && e.dataset.round === String(round));
}

describe('renderRoundTracker', () => {
    afterEach(() => { delete global.document; });

    function mount() {
        const root = buildTrackerDom();
        global.document = {
            getElementById: (id) => root._all().find((e) => e.attrs.id === id) || null,
        };
        return root;
    }

    const games = {
        1: { color: 'White', opponent: 'A', result: 'W', isBye: false, gameId: '1' },
        2: { color: 'Black', opponent: 'B', result: 'L', isBye: false, gameId: '2' },
        3: { color: 'White', opponent: 'C', result: 'D', isBye: false, gameId: '3' },
        4: { isBye: true, byeType: 'half', result: 'H' },
    };

    it('renders a half-point bye label', () => {
        const root = mount();
        renderRoundTracker(games, 7, 4, STATE.RESULTS, 4);
        expect(findPanel(root, 4).querySelector('.pairing-opponent button').textContent).toBe('Half-point bye');
    });

    it('does not crash on re-render after a bye (regression: stripped .opponent-link)', () => {
        const root = mount();
        expect(() => {
            renderRoundTracker(games, 7, 4, STATE.RESULTS, 4); // strips opponent-link on R4
            renderRoundTracker(games, 7, 4, STATE.RESULTS, 4); // re-render — used to throw
        }).not.toThrow();
        expect(findPanel(root, 4).querySelector('.pairing-opponent button').textContent).toBe('Half-point bye');
    });

    it('survives a bye round becoming a game (and vice versa) across re-renders', () => {
        const root = mount();
        renderRoundTracker(games, 7, 4, STATE.RESULTS, 4);
        const swapped = {
            ...games,
            3: { isBye: true, byeType: 'half', result: 'H' },
            4: { color: 'White', opponent: 'D', result: 'W', isBye: false, gameId: '4' },
        };
        expect(() => renderRoundTracker(swapped, 7, 4, STATE.RESULTS, 4)).not.toThrow();
        expect(findPanel(root, 4).querySelector('.pairing-opponent button').textContent).toBe('D');
        expect(findPanel(root, 3).querySelector('.pairing-opponent button').textContent).toBe('Half-point bye');
    });
});
