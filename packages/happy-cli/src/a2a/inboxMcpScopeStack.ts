/**
 * Ref-counted scope stack for Happy inbox MCP (list/read/mark).
 * MCP is allowed while the stack is non-empty.
 *
 * Typical nesting: inbox-turn → inbox-task (Task subagent) → pop task → pop turn.
 */

export type A2AInboxMcpScope = 'inbox-turn' | 'inbox-task';

export class A2AInboxMcpScopeStack {
  private stack: A2AInboxMcpScope[] = [];

  isAllowed(): boolean {
    return this.stack.length > 0;
  }

  hasScope(scope: A2AInboxMcpScope): boolean {
    return this.stack.includes(scope);
  }

  depth(): number {
    return this.stack.length;
  }

  push(scope: A2AInboxMcpScope): void {
    this.stack.push(scope);
  }

  /** Pop the topmost matching scope (search from the top). */
  pop(scope: A2AInboxMcpScope): boolean {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if (this.stack[i] === scope) {
        this.stack.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /** Remove all entries of a scope (e.g. safety net after task_complete). */
  popAll(scope: A2AInboxMcpScope): number {
    const before = this.stack.length;
    this.stack = this.stack.filter((entry) => entry !== scope);
    return before - this.stack.length;
  }

  /** Human-readable snapshot for logs when MCP calls are blocked. */
  describe(): string {
    if (this.stack.length === 0) {
      return 'empty';
    }
    return this.stack.join('>');
  }
}
