import { useEffect, useState } from 'react';
import { authService } from '../../lib/auth';

/**
 * An image whose bytes require the session.
 *
 * Post images used to live in a public Supabase bucket and render straight from
 * their url, so a photo posted in a private stream was readable by anyone who
 * came across the link — forever, and without an account. Convex storage has no
 * public url at all: `/posts/image` re-checks the session AND the stream on
 * every fetch.
 *
 * That check reads a Bearer header, and an `<img src>` cannot send one, so the
 * bytes are fetched here and handed to the tag as an object URL. Putting the
 * token in the query string instead would have avoided this component and put a
 * live session token into browser history and referrer headers.
 *
 * The object URL is revoked on unmount and whenever the source changes; a feed
 * that scrolls through hundreds of images would otherwise pin every one of them
 * in memory for the life of the tab.
 */
interface AuthedImageProps {
  src: string | null;
  alt: string;
  className?: string;
  onClick?: () => void;
}

export function AuthedImage({ src, alt, className, onClick }: AuthedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setObjectUrl(null);
      return;
    }

    // Guards against a slow response for a previous src resolving after a newer
    // one and overwriting it — and against setting state after unmount.
    let cancelled = false;
    let created: string | null = null;

    setFailed(false);
    // Cleared BEFORE the new fetch. The cleanup below revokes the previous
    // object URL while this state still held it, so a changed `src` rendered a
    // revoked URL — a broken image — for one frame.
    setObjectUrl(null);

    (async () => {
      try {
        const token = authService.getToken();
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(src, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(String(response.status));

        const blob = await response.blob();
        if (cancelled) return;

        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        // A 404 here is the access check refusing, not a broken file. Either
        // way the post still renders — it just has no image.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  if (!src || failed) return null;

  if (!objectUrl) {
    return <div className={`${className ?? ''} bg-slate-100 animate-pulse`} aria-hidden="true" />;
  }

  return <img src={objectUrl} alt={alt} className={className} onClick={onClick} />;
}
