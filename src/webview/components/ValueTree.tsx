import React, { memo, useState } from 'react';
import type { DetailMessage } from '../messages';
import type { Matcher } from '../search-highlight';
import { PAGE_SIZE, nextVisible, planExpandAll, type BranchNode, type DetailBlock, type DetailSearch, type TreeEntry, type TreeNode } from '../tree-model';
import { Highlight } from './Highlight';

const NO_ENTRIES: readonly TreeEntry[] = [];
const NO_NODES: ReadonlySet<TreeNode> = new Set();

/**
 * An "Expand all" / "Collapse all" request, broadcast to one tree. Every node
 * applies it once (by `id`) to its own state, so nothing else has to change and
 * a node that mounts later (a freshly opened child) adopts the latest request.
 */
interface TreeCommand {
  id: number;
  open: ReadonlySet<TreeNode>;
}

export interface DetailValueProps {
  detail: DetailMessage;
  /** The layout from `planDetail`, computed once per detail message by the caller. */
  blocks: readonly DetailBlock[] | undefined;
  matcher: Matcher | undefined;
  /** Present while the in-value search box is in use: which nodes to open and keep in view. */
  search: DetailSearch | undefined;
}

/**
 * The value pane for one selected event.
 *
 * With nothing to expand it renders the same `<pre class="value">` the pane
 * has always used (now with search highlights); otherwise ordinary arguments
 * stay as text and each object/array/JSON-string argument becomes a tree.
 */
export const DetailValue = memo(function DetailValue({ detail, blocks, matcher, search }: DetailValueProps): React.ReactElement {
  if (!blocks) {
    return (
      <pre className="value">
        <Highlight text={detail.detail} matcher={matcher} />
      </pre>
    );
  }
  return (
    <div className="value-blocks">
      {blocks.map((block, index) =>
        block.kind === 'text' ? (
          <pre key={index} className="value">
            <Highlight text={block.text} matcher={matcher} />
          </pre>
        ) : (
          <ValueTree key={index} root={block.root} fromText={block.fromText} matcher={matcher} search={search} />
        )
      )}
    </div>
  );
});

interface ValueTreeProps {
  root: TreeNode;
  fromText: boolean;
  matcher: Matcher | undefined;
  search: DetailSearch | undefined;
}

/** One tree plus its Expand all / Collapse all controls. */
function ValueTree({ root, fromText, matcher, search }: ValueTreeProps): React.ReactElement {
  const [command, setCommand] = useState<TreeCommand | undefined>(undefined);
  const [limited, setLimited] = useState(false);
  const expandable = root.kind === 'branch';
  const issue = (open: ReadonlySet<TreeNode>): void => setCommand((previous) => ({ id: (previous?.id ?? 0) + 1, open }));
  return (
    <div className="rl-tree">
      <div className="rl-tree-bar">
        {fromText ? (
          <span className="rl-tree-tag" title="This argument is a string that contains valid JSON">
            JSON text
          </span>
        ) : null}
        {expandable ? (
          <>
            <button
              type="button"
              className="rl-tree-action"
              title="Open every node (up to a size limit)"
              onClick={() => {
                const plan = planExpandAll(root);
                setLimited(!plan.complete);
                issue(plan.open);
              }}
            >
              Expand all
            </button>
            <button
              type="button"
              className="rl-tree-action"
              title="Close every nested node"
              onClick={() => {
                setLimited(false);
                issue(NO_NODES);
              }}
            >
              Collapse all
            </button>
            {limited ? (
              <span className="rl-tree-note" role="status">
                Opened the top levels only; the rest is large, open it node by node.
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <TreeRow node={root} depth={0} matcher={matcher} search={search} command={command} />
    </div>
  );
}

interface TreeRowProps {
  /** Key, index or Map key; absent for a root. */
  label?: string;
  sep?: string;
  node: TreeNode;
  depth: number;
  matcher: Matcher | undefined;
  search: DetailSearch | undefined;
  command: TreeCommand | undefined;
}

/**
 * Memoised on stable props (nodes are cached by the model, the matcher by the
 * query), so expanding one node or paging its children re-renders only that
 * node's own rows, and a new snapshot re-renders none of them.
 */
const TreeRow = memo(function TreeRow({ label, sep, node, depth, matcher, search, command }: TreeRowProps): React.ReactElement {
  if (node.kind === 'branch') {
    return <Branch label={label} sep={sep} node={node} depth={depth} matcher={matcher} search={search} command={command} />;
  }
  return (
    <div className="rl-tree-row">
      <span className="rl-tree-gap" aria-hidden="true" />
      {label !== undefined ? <Key label={label} sep={sep} matcher={matcher} /> : null}
      <span className={`rl-tree-leaf rl-t-${node.cls}`}>
        <Highlight text={node.text} matcher={matcher} />
      </span>
    </div>
  );
});

function Key({ label, sep, matcher }: { label: string; sep?: string; matcher: Matcher | undefined }): React.ReactElement {
  return (
    <>
      <span className="rl-tree-key">
        <Highlight text={label} matcher={matcher} />
      </span>
      <span className="rl-tree-sep">{sep}</span>
    </>
  );
}

interface BranchProps {
  label?: string;
  sep?: string;
  node: BranchNode;
  depth: number;
  matcher: Matcher | undefined;
  search: DetailSearch | undefined;
  command: TreeCommand | undefined;
}

function Branch({ label, sep, node, depth, matcher, search, command }: BranchProps): React.ReactElement {
  // Open/collapsed and paging live in this node alone: toggling it can't touch its siblings.
  // `userOpen` is the person's explicit choice and always wins; otherwise a node is open at
  // the root, or when the in-value search has a match somewhere below it.
  // An Expand all / Collapse all request counts as the person's choice, applied once per request.
  // The root always stays open, so "Collapse all" returns to the initial view.
  const fromCommand = (cmd: TreeCommand | undefined): boolean | undefined => (cmd ? depth === 0 || cmd.open.has(node) : undefined);
  const [userOpen, setUserOpen] = useState<boolean | undefined>(() => fromCommand(command));
  const [seenCommand, setSeenCommand] = useState(command?.id);
  if (command && command.id !== seenCommand) {
    setSeenCommand(command.id);
    setUserOpen(fromCommand(command));
  }
  const [shown, setShown] = useState(PAGE_SIZE);
  const open = userOpen ?? (depth === 0 || (search?.open.has(node) ?? false));
  const entries = open ? node.children() : NO_ENTRIES;
  // Keep the first match inside the rendered page.
  const firstHit = open && search ? entries.findIndex((entry) => search.hits.has(entry.node)) : -1;
  const visible = Math.min(entries.length, Math.max(shown, firstHit >= 0 ? (Math.floor(firstHit / PAGE_SIZE) + 1) * PAGE_SIZE : 0));
  const childSep = node.shape === 'map' ? ' => ' : ': ';

  return (
    <div className="rl-tree-node">
      <div className="rl-tree-row">
        <button
          type="button"
          className="rl-tree-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label ?? 'value'}`}
          onClick={() => setUserOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        {label !== undefined ? <Key label={label} sep={sep} matcher={matcher} /> : null}
        <span className="rl-tree-summary">{node.summary}</span>
      </div>
      {open ? (
        <div className="rl-tree-children">
          {entries.slice(0, visible).map((entry, index) => (
            <TreeRow
              key={index}
              label={entry.label}
              sep={childSep}
              node={entry.node}
              depth={depth + 1}
              matcher={matcher}
              search={search}
              command={command}
            />
          ))}
          {visible < entries.length ? (
            <button type="button" className="rl-tree-more" onClick={() => setShown(nextVisible(visible, entries.length))}>
              Show {Math.min(PAGE_SIZE, entries.length - visible)} more ({entries.length - visible} remaining)
            </button>
          ) : null}
          {node.omitted > 0 ? <div className="rl-tree-note">… {node.omitted} more not captured</div> : null}
        </div>
      ) : null}
    </div>
  );
}
