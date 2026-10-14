import { describe, expect, it } from 'vitest';
import { parseCommands, type TelegramUpdate } from '../src/commands.js';

const ADMINS = [1954950984, 1762222862];
const GROUP = -5558279555;
const msg = (id: number, from: number, text: string, chat = GROUP): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, text, from: { id: from, username: from === 1954950984 ? 'dex' : undefined }, chat: { id: chat } },
});

describe('parseCommands', () => {
  it('accepts /status /pause /help from admins only, in group or DM', () => {
    const cmds = parseCommands(
      [
        msg(1, 1954950984, '/status'),
        msg(2, 1762222862, '/pause now please', 1762222862),
        msg(3, 424242, '/pause'),
        msg(4, 1954950984, 'hello'),
        msg(5, 1954950984, '/unpause'),
        msg(6, 1954950984, '/Help'),
      ],
      ADMINS,
    );
    expect(cmds.map((c) => `${c.name}:${c.fromName}:${c.chatId}`)).toEqual([
      'status:@dex:-5558279555',
      'pause:1762222862:1762222862',
      'help:@dex:-5558279555',
    ]);
  });
  it('honours @botname suffixes and ignores commands aimed at another bot', () => {
    const cmds = parseCommands([msg(1, 1954950984, '/status@EticaWatchBot'), msg(2, 1954950984, '/status@OtherBot')], ADMINS, 'EticaWatchBot');
    expect(cmds.map((c) => c.name)).toEqual(['status']);
  });
  it('ignores updates without a message or sender', () => {
    expect(parseCommands([{ update_id: 9 }, { ...msg(10, 1954950984, '/status'), message: undefined }], ADMINS)).toEqual([]);
  });
});
