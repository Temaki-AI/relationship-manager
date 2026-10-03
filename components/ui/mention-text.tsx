'use client';

import Link from 'next/link';

const MENTION_REGEX = /@\[([^\]]+)\]\(id:(\d+)\)/g;

type Segment =
  | { type: 'text'; value: string }
  | { type: 'mention'; name: string; id: string };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MENTION_REGEX)) {
    const start = match.index!;
    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    segments.push({ type: 'mention', name: match[1], id: match[2] });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

export function MentionText({ text, className }: { text: string; className?: string }) {
  const segments = parseSegments(text);

  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.type === 'mention' ? (
          <Link
            key={i}
            href={`/contacts/${seg.id}`}
            className="inline-flex items-center gap-0.5 px-1 py-0 text-primary font-medium hover:underline rounded bg-primary/5"
            onClick={(e) => e.stopPropagation()}
          >
            @{seg.name}
          </Link>
        ) : (
          <span key={i}>{seg.value}</span>
        )
      )}
    </span>
  );
}

export function hasMentions(text: string | null | undefined): boolean {
  if (!text) return false;
  return MENTION_REGEX.test(text);
}
