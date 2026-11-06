import { beforeEach, describe, expect, it } from 'vitest';
import { ECHO_WAIT_MS, ENTRY_TTL_MS, isPredictable, LocalEchoModel } from './local-echo-model';

/** Type one key and let it echo normally, which earns trust. */
function earnTrust(m: LocalEchoModel, now = 0): void {
  const id = m.noteInput('a', now);
  m.noteAck(id as number, now + 100);
  m.noteOutput(now + 110, 'a');
}

describe('isPredictable', () => {
  it('accepts plain text and CJK from an IME', () => {
    expect(isPredictable('a')).toBe(true);
    expect(isPredictable('你好')).toBe(true);
  });

  it('rejects control input, escape sequences and pastes', () => {
    expect(isPredictable('\r')).toBe(false);
    expect(isPredictable('\x1b[A')).toBe(false);
    expect(isPredictable('\x03')).toBe(false);
    expect(isPredictable('')).toBe(false);
    expect(isPredictable('x'.repeat(9))).toBe(false);
  });
});

describe('LocalEchoModel', () => {
  let m: LocalEchoModel;
  beforeEach(() => {
    m = new LocalEchoModel();
  });

  it('never predicts the first key, because it may be a password', () => {
    m.noteInput('s', 0);
    expect(m.text).toBe('');
  });

  it('shows keys straight away once the app has proved it echoes', () => {
    earnTrust(m);
    m.noteInput('b', 200);
    m.noteInput('c', 210);
    expect(m.text).toBe('bc');
  });

  it('removes a key when its echo arrives, not before', () => {
    earnTrust(m);
    const id = m.noteInput('b', 200) as number;
    m.noteAck(id, 450);
    expect(m.text).toBe('b');
    m.noteOutput(460, 'b');
    expect(m.text).toBe('');
  });

  it('copes with the echo overtaking the ack', () => {
    earnTrust(m);
    const id = m.noteInput('b', 200) as number;
    m.noteOutput(440, 'b');
    expect(m.text).toBe('b');
    m.noteAck(id, 450);
    expect(m.text).toBe('');
  });

  it('does not drop keys the Host has not accepted yet', () => {
    earnTrust(m);
    const first = m.noteInput('b', 200) as number;
    m.noteInput('c', 300);
    m.noteAck(first, 450);
    m.noteOutput(460, 'b');
    expect(m.text).toBe('c');
  });

  it('a password prompt never earns trust, so nothing is ever drawn', () => {
    for (let t = 0; t < 5; t++) {
      const now = t * 1000;
      const id = m.noteInput('p', now);
      if (id !== null) m.noteAck(id, now + 100);
      m.tick(now + 100 + ECHO_WAIT_MS);
      expect(m.text).toBe('');
    }
  });

  it('a masked prompt answering each key with * never earns trust', () => {
    for (let t = 0; t < 5; t++) {
      const now = t * 1000;
      const id = m.noteInput('s', now);
      if (id !== null) m.noteAck(id, now + 100);
      m.noteOutput(now + 110, '*');
      m.tick(now + 110 + ECHO_WAIT_MS);
      expect(m.text).toBe('');
    }
  });

  it('finds the echoed key inside a coloured redraw of the line', () => {
    const id = m.noteInput('g', 0) as number;
    m.noteAck(id, 100);
    m.noteOutput(110, '\x1b[93mg\x1b[0m');
    m.noteInput('i', 200);
    expect(m.text).toBe('i');
  });

  it('earns trust when the echo overtakes the ack', () => {
    const id = m.noteInput('g', 0) as number;
    m.noteOutput(90, 'g');
    m.noteAck(id, 100);
    m.noteInput('i', 200);
    expect(m.text).toBe('i');
  });

  it('Enter withdraws trust, so a prompt on the next line stays hidden', () => {
    earnTrust(m);
    m.noteInput('\r', 200);
    m.noteInput('s', 300);
    expect(m.text).toBe('');
  });

  it('a control key clears what is showing', () => {
    earnTrust(m);
    m.noteInput('b', 200);
    m.noteInput('\x1b[D', 210);
    expect(m.text).toBe('');
  });

  it('backspace removes the last predicted key', () => {
    earnTrust(m);
    m.noteInput('b', 200);
    m.noteInput('c', 210);
    expect(m.noteInput('\x7f', 220)).toBeNull();
    expect(m.text).toBe('b');
  });

  it('stops predicting when an echo never comes', () => {
    earnTrust(m);
    const id = m.noteInput('b', 200) as number;
    m.noteAck(id, 300);
    expect(m.tick(300 + ECHO_WAIT_MS)).toBe(true);
    expect(m.text).toBe('');
    m.noteInput('c', 1000);
    expect(m.text).toBe('');
  });

  it('gives up on keys the Host never accepted', () => {
    earnTrust(m);
    m.noteInput('b', 200);
    m.tick(200 + ENTRY_TTL_MS);
    expect(m.text).toBe('');
    expect(m.busy).toBe(false);
  });
});
