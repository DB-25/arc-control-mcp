/**
 * Key and modifier tables for Input.dispatchKeyEvent. Pure data and parsing, so
 * it is unit-tested without a browser.
 */
import { ArcError } from '../jxa.js';

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const MODIFIER_ALIASES = {
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  control: 'Control', ctrl: 'Control',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta',
  shift: 'Shift'
};

// Modifier keys are sent as key events of their own, so a page listening for
// keydown on Shift or Meta sees them, as it would from a keyboard.
const MODIFIER_KEYS = {
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 }
};

const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 }
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n };

const NAME_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', ' ': 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

// US layout punctuation: [code, virtual key code]
const PUNCTUATION = {
  '-': ['Minus', 189], '=': ['Equal', 187], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
  ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], '`': ['Backquote', 192]
};

// On macOS the renderer does not turn Cmd+A into "select all": the menu bar
// does, which a synthesised event never reaches. Chrome accepts the editing
// command by name instead, so shortcuts that edit text carry it.
const EDIT_COMMANDS = { a: ['selectAll'], c: ['copy'], v: ['paste'], x: ['cut'], z: ['undo'] };

/** Key definition for one name ("Enter", "ArrowDown") or one character ("a", "7", "!"). */
export function keyDefinition(name) {
  const named = NAMED[name] ?? NAMED[NAME_ALIASES[name.toLowerCase()]] ?? NAMED[[...Object.keys(NAMED)].find((k) => k.toLowerCase() === name.toLowerCase())];
  if (named) return named;
  if ([...name].length !== 1) {
    throw new ArcError(
      `Unknown key "${name}". Use a single character, or one of: ${Object.keys(NAMED).join(', ')}. Combine with modifiers as "Meta+A" or "Control+Shift+Tab".`
    );
  }
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
  if (PUNCTUATION[name]) return { key: name, code: PUNCTUATION[name][0], vk: PUNCTUATION[name][1], text: name };
  // Anything else (accents, symbols, emoji) has no US key: typed as text only.
  return { key: name, code: '', vk: 0, text: name };
}

/** "Meta+Shift+A" -> { modifiers: ['Meta','Shift'], definition, bits }. A trailing "+" is the plus key. */
export function parseCombo(combo) {
  if (typeof combo !== 'string' || combo === '') throw new ArcError('A key is required, for example Enter or Meta+A.');
  const parts = combo === '+' ? ['+'] : combo.length > 1 && combo.endsWith('+') ? [...combo.slice(0, -2).split('+').filter(Boolean), '+'] : combo.split('+');
  const keyName = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) throw new ArcError(`Unknown modifier "${part}" in "${combo}". Use Alt, Control, Meta (Cmd) or Shift.`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const bits = modifiers.reduce((sum, m) => sum | MODIFIER_BITS[m], 0);
  // A bare modifier name ("Shift") is a legitimate key to press on its own.
  const lone = !parts.length && MODIFIER_ALIASES[keyName.toLowerCase()];
  const definition = lone ? MODIFIER_KEYS[lone] : keyDefinition(keyName);
  return { modifiers, bits, definition };
}

/**
 * The Input.dispatchKeyEvent sequence for one press: modifiers down, the key
 * down and up, modifiers up. Text is only attached when no Ctrl, Meta or Alt is
 * held, since a shortcut types no character.
 */
export function keyPressEvents(combo) {
  const { modifiers, bits, definition } = parseCombo(combo);
  const events = [];
  let held = 0;
  for (const m of modifiers) {
    held |= MODIFIER_BITS[m];
    events.push({ type: 'rawKeyDown', modifiers: held, key: MODIFIER_KEYS[m].key, code: MODIFIER_KEYS[m].code, windowsVirtualKeyCode: MODIFIER_KEYS[m].vk });
  }
  const shortcut = (bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) !== 0;
  const text = !shortcut ? definition.text : undefined;
  const base = { modifiers: bits, key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk };
  const commands = bits & MODIFIER_BITS.Meta ? EDIT_COMMANDS[definition.key.toLowerCase()] : undefined;
  events.push({
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(commands ? { commands } : {})
  });
  events.push({ ...base, type: 'keyUp' });
  for (const m of [...modifiers].reverse()) {
    held &= ~MODIFIER_BITS[m];
    events.push({ type: 'keyUp', modifiers: held, key: MODIFIER_KEYS[m].key, code: MODIFIER_KEYS[m].code, windowsVirtualKeyCode: MODIFIER_KEYS[m].vk });
  }
  return events;
}

/** Events for typing one character with no modifiers; a newline is the Enter key. */
export function charEvents(char) {
  return keyPressEvents(char === '\n' ? 'Enter' : char);
}

export const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 };
