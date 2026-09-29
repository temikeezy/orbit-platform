/**
 * Detects when a user's level increases since their last visit and shows a
 * confetti animation + toast celebration. Uses localStorage to persist
 * the last-known level across sessions.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { Trophy } from 'lucide-react';

/**
 * Scoped to the account, because a browser is not a person.
 *
 * A single shared key meant the LAST signed-in user's level was the benchmark
 * for the NEXT one: on a shared machine, signing in after someone on a lower
 * level fired a "Level up!" celebration and a toast for a level the new user
 * had held all along. Keying on the user id makes the comparison per-account.
 */
const lastLevelKey = (userId: string) => `orbit_last_seen_level:${userId}`;

export function LevelUpCelebration() {
  const { user } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [newLevel, setNewLevel] = useState<number | null>(null);

  /**
   * Runs on every change to `user`, deliberately.
   *
   * A `hasChecked` ref used to make this fire once per mount, which meant it
   * always ran against the CACHED user. AuthContext renders from localStorage on
   * first paint and refreshes from the server a moment later — so on the very
   * visit where someone levelled up, the check saw their old level, latched, and
   * ignored the fresh one when it arrived. The celebration then appeared on the
   * NEXT page load instead, one navigation after the achievement.
   *
   * No latch is needed: the stored level is written immediately after showing,
   * so a re-run at the same level cannot celebrate twice.
   */
  useEffect(() => {
    if (!user) return;

    const currentLevel = user.current_level ?? 1;
    const storedLevel = parseInt(localStorage.getItem(lastLevelKey(user.id)) ?? '0', 10);

    if (storedLevel > 0 && currentLevel > storedLevel) {
      setNewLevel(currentLevel);
      setShowModal(true);
      toast.success(`Level up! You reached Level ${currentLevel} 🎉`, { duration: 6000 });
    }

    localStorage.setItem(lastLevelKey(user.id), String(currentLevel));
  }, [user]);

  useEffect(() => {
    if (!showModal) return;

    // Simple CSS confetti using inline canvas
    runConfetti();
    const timer = setTimeout(() => setShowModal(false), 5000);
    return () => clearTimeout(timer);
  }, [showModal]);

  const runConfetti = () => {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return; }

    const particles: Array<{
      x: number; y: number; vx: number; vy: number;
      color: string; size: number; rotation: number; rotSpeed: number;
    }> = [];

    const colors = ['#2DD881', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

    for (let i = 0; i < 120; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -10,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 8 + 4,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.2,
      });
    }

    let frame: number;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach((p) => {
        if (p.y < canvas.height + 10) {
          alive = true;
          p.x += p.vx;
          p.y += p.vy;
          p.rotation += p.rotSpeed;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        }
      });
      if (alive) {
        frame = requestAnimationFrame(animate);
      } else {
        canvas.remove();
      }
    };

    frame = requestAnimationFrame(animate);
    setTimeout(() => {
      cancelAnimationFrame(frame);
      canvas.remove();
    }, 5000);
  };

  if (!showModal || newLevel === null) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-[9998] pointer-events-none">
      <div className="bg-white rounded-2xl shadow-2xl p-10 max-w-sm text-center pointer-events-auto border-4 border-iih-green animate-bounce-once">
        <Trophy className="w-16 h-16 text-amber-500 mx-auto mb-4" />
        <h2 className="text-3xl font-extrabold text-slate-800 mb-2">Level Up! 🚀</h2>
        <p className="text-slate-600 text-lg mb-6">
          You've reached <span className="font-bold text-iih-green">Level {newLevel}</span>!
        </p>
        <button
          onClick={() => setShowModal(false)}
          className="bg-iih-green hover:bg-iih-green-dark text-white font-bold px-8 py-3 rounded-lg transition-colors"
        >
          Awesome! 🎉
        </button>
      </div>
    </div>
  );
}
