import { formatConversation } from './read-query.action';

const conversation = {
  slug: 'analyst-1',
  roleName: 'Analyst',
  question: 'What is the revenue?',
  status: 'awaiting_user',
  createdAt: '2026-07-06T14:32:00.000Z',
};

describe('formatConversation', () => {
  it('formats the date in the system locale when no company timezone is set', () => {
    const out = formatConversation(conversation, [], null);
    expect(out).toContain('Slug:   analyst-1');
    expect(out).toContain('Status: awaiting_user');
    expect(out).toContain('--- Question ---');
    expect(out).toContain('What is the revenue?');
  });

  it('localizes the date to the company timezone when set', () => {
    const utc = formatConversation(conversation, [], 'UTC');
    const tokyo = formatConversation(conversation, [], 'Asia/Tokyo');
    // Same instant, different timezone -> different rendered clock time.
    expect(utc).not.toBe(tokyo);
  });

  it('includes messages with their author and content', () => {
    const out = formatConversation(
      conversation,
      [
        {
          author: 'alice',
          authorIdentifier: 'alice@example.com',
          content: 'Here you go.',
          timestamp: '2026-07-06T15:00:00.000Z',
        },
      ],
      null,
    );
    expect(out).toContain('--- Messages ---');
    expect(out).toContain('alice (alice@example.com)');
    expect(out).toContain('Here you go.');
  });

  it('includes context when present', () => {
    const out = formatConversation(
      { ...conversation, context: 'Extra background.' },
      [],
      null,
    );
    expect(out).toContain('--- Context ---');
    expect(out).toContain('Extra background.');
  });
});
