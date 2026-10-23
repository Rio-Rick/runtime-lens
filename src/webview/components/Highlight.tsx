import React from 'react';
import { splitByMatches, type Matcher } from '../search-highlight';

export interface HighlightProps {
  text: string;
  /** `undefined` (empty search) renders the text untouched. */
  matcher: Matcher | undefined;
}

/**
 * `text` with every search match wrapped in a `<mark>`. Built from React
 * elements only (never `innerHTML`), so log content can't inject markup, and
 * with no match it returns the bare string: the same DOM as not using it.
 */
export function Highlight({ text, matcher }: HighlightProps): React.ReactElement {
  if (!matcher) {
    return <>{text}</>;
  }
  const segments = splitByMatches(text, matcher);
  if (segments.length === 1 && !segments[0].match) {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rl-match">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </>
  );
}
