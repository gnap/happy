import { describe, expect, it } from 'vitest';
import { A2AInboxMcpScopeStack } from './inboxMcpScopeStack';

describe('A2AInboxMcpScopeStack', () => {
  it('allows MCP while stack is non-empty', () => {
    const stack = new A2AInboxMcpScopeStack();
    expect(stack.isAllowed()).toBe(false);
    stack.push('inbox-turn');
    expect(stack.isAllowed()).toBe(true);
    stack.push('inbox-task');
    expect(stack.hasScope('inbox-task')).toBe(true);
    stack.pop('inbox-task');
    expect(stack.isAllowed()).toBe(true);
    stack.pop('inbox-turn');
    expect(stack.isAllowed()).toBe(false);
  });

  it('pop removes the topmost matching scope', () => {
    const stack = new A2AInboxMcpScopeStack();
    stack.push('inbox-turn');
    stack.push('inbox-task');
    stack.push('inbox-task');
    expect(stack.pop('inbox-task')).toBe(true);
    expect(stack.depth()).toBe(2);
    expect(stack.pop('inbox-task')).toBe(true);
    expect(stack.depth()).toBe(1);
  });

  it('popAll clears every matching scope', () => {
    const stack = new A2AInboxMcpScopeStack();
    stack.push('inbox-turn');
    stack.push('inbox-task');
    stack.push('inbox-task');
    expect(stack.popAll('inbox-task')).toBe(2);
    expect(stack.describe()).toBe('inbox-turn');
  });
});
