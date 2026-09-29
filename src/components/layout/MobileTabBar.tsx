import { useLocation, useNavigate } from 'react-router-dom';
import { Home, CheckSquare, Users, Bell, Layers } from 'lucide-react';

const TABS = [
  { path: '/', label: 'Home', icon: Home, exact: true },
  { path: '/tasks', label: 'Tasks', icon: CheckSquare, exact: false },
  { path: '/streams', label: 'Streams', icon: Layers, exact: false },
  { path: '/community', label: 'Community', icon: Users, exact: false },
  { path: '/notifications', label: 'Alerts', icon: Bell, exact: false },
] as const;

export function MobileTabBar() {
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path: string, exact: boolean) =>
    exact ? location.pathname === path : location.pathname.startsWith(path);

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-orbit-ink-soft bg-orbit-ink md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="flex items-stretch">
        {TABS.map(({ path, label, icon: Icon, exact }) => {
          const active = isActive(path, exact);
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors relative ${
                active
                  ? 'text-iih-green'
                  : 'text-slate-300 hover:text-white'
              }`}
              aria-label={label}
            >
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-iih-green rounded-full" />
              )}
              <Icon className={`w-5 h-5 ${active ? 'stroke-[2.5]' : ''}`} />
              <span className={`text-[10px] font-medium ${active ? 'font-semibold' : ''}`}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
