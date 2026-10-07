import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { BookmarkCheck, Coins, Sparkles, Landmark } from 'lucide-react';

export type MainTabKey = 'portfolio' | 'gold' | 'ai-stock-pick' | 'bank-stocks';

interface MobileBottomTabBarProps {
  activeTab: MainTabKey;
  onTabChange: (key: MainTabKey) => void;
}

const TABS: Array<{
  key: MainTabKey;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { key: 'portfolio',     label: '自选', icon: BookmarkCheck },
  { key: 'gold',          label: '金价', icon: Coins },
  { key: 'ai-stock-pick', label: '选股', icon: Sparkles },
  { key: 'bank-stocks',   label: '银行', icon: Landmark },
];

export const MobileBottomTabBar: React.FC<MobileBottomTabBarProps> = ({
  activeTab,
  onTabChange,
}) => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      role="navigation"
      aria-label="移动端底部主导航栏"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 px-3.5 pb-safe pb-2 pointer-events-none select-none transition-colors"
    >
      {/* 悬浮高斯微岛主体 (Floating Glassmorphic Capsule) */}
      <nav
        className="pointer-events-auto relative w-full h-[58px] px-1.5 py-1.5 rounded-[26px]
                   bg-white/90 dark:bg-[#12131a]/90 backdrop-blur-2xl
                   border border-slate-200/80 dark:border-white/[0.1]
                   shadow-[0_12px_36px_-6px_rgba(0,0,0,0.1),0_4px_16px_rgba(0,0,0,0.04)]
                   dark:shadow-[0_16px_40px_-8px_rgba(0,0,0,0.6),0_2px_10px_rgba(0,0,0,0.4)]
                   flex items-center justify-between"
      >
        {/* 顶部发丝级微光层 (Inner Specular Highlight) */}
        <div
          aria-hidden="true"
          className="absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/80 dark:via-white/20 to-transparent pointer-events-none"
        />

        <div className="grid grid-cols-4 w-full h-full relative items-center">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const IconComp = tab.icon;

            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => onTabChange(tab.key)}
                className="group relative flex flex-col items-center justify-center h-full w-full rounded-2xl cursor-pointer transition-transform active:scale-95 touch-manipulation z-10"
              >
                {/* 核心大厂流体胶囊药丸 (Fluid Pill Slider) */}
                {isActive && (
                  <motion.div
                    layoutId="mobile-floating-tab-active-pill"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', damping: 30, stiffness: 360, bounce: 0.08 }
                    }
                    className="absolute inset-x-1 inset-y-0.5 rounded-[18px]
                               bg-blue-500/[0.12] dark:bg-blue-400/[0.15]
                               border border-blue-500/20 dark:border-blue-400/25
                               shadow-[0_2px_8px_rgba(0,102,204,0.08)]
                               dark:shadow-[0_2px_10px_rgba(41,151,255,0.12)]
                               pointer-events-none"
                  />
                )}

                {/* 图标容器：带微弹簧位移动效 */}
                <motion.div
                  animate={
                    prefersReducedMotion
                      ? undefined
                      : isActive
                        ? { y: -1, scale: 1.05 }
                        : { y: 0, scale: 1 }
                  }
                  transition={{ type: 'spring', damping: 26, stiffness: 380 }}
                  className={`relative transition-colors duration-200 ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-slate-400 dark:text-slate-500 group-hover:text-slate-600 dark:group-hover:text-slate-300'
                  }`}
                >
                  <IconComp size={19} />
                </motion.div>

                {/* 标签文字：排版紧凑清晰，状态分明 */}
                <span
                  className={`text-[10px] mt-0.5 tracking-tight font-medium transition-colors duration-200 leading-none ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400 font-bold'
                      : 'text-slate-400 dark:text-slate-500 font-normal group-hover:text-slate-600 dark:group-hover:text-slate-300'
                  }`}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
