import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH, cleanName, parseMessage, readMetadata } from './protocol';

describe('room protocol', () => {
  it('accepts a well formed welcome', () => {
    expect(parseMessage({ type: 'welcome', you: 'Ann', host: 'Bob', members: [{ id: 'abc-1', name: 'Eve' }] })).toEqual({
      type: 'welcome',
      you: 'Ann',
      host: 'Bob',
      members: [{ id: 'abc-1', name: 'Eve' }]
    });
  });

  it('rejects a welcome with a bad member or too many members', () => {
    expect(parseMessage({ type: 'welcome', you: 'Ann', host: 'Bob', members: [{ id: '../x', name: 'Eve' }] })).toBeNull();
    const members = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id }));
    expect(parseMessage({ type: 'welcome', you: 'Ann', host: 'Bob', members })).toBeNull();
  });

  it('drops unknown, malformed and oversized messages', () => {
    expect(parseMessage('hello')).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage({ type: 'shutdown' })).toBeNull();
    expect(parseMessage({ type: 'chat', text: 42 })).toBeNull();
    expect(parseMessage({ type: 'chat', text: '   ' })).toBeNull();
    expect(parseMessage({ type: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH + 1) })).toBeNull();
    expect(parseMessage({ type: 'peer-left', id: '' })).toBeNull();
  });

  it('reads media state as strict booleans', () => {
    expect(parseMessage({ type: 'media-state', mic: 'yes', cam: true, screen: 1 })).toEqual({
      type: 'media-state',
      mic: false,
      cam: true,
      screen: false
    });
  });

  it('cleans names', () => {
    expect(cleanName('  Ann\u0000\n ')).toBe('Ann');
    expect(cleanName('x'.repeat(100))).toHaveLength(MAX_NAME_LENGTH);
    expect(cleanName(42)).toBe('');
  });

  it('reads connection metadata', () => {
    expect(readMetadata({ v: 2, name: ' Ann ', room: 'room-1' })).toEqual({ v: 2, name: 'Ann', room: 'room-1' });
    expect(readMetadata(undefined)).toBeNull();
    expect(readMetadata({ v: '2', room: 'room-1' })).toBeNull();
    expect(readMetadata({ v: 2, room: 'bad id!' })).toBeNull();
  });
});
