interface BorderBeamProps {
  /** 边框圆角 */
  borderRadius?: string;
  /** 渐变起始颜色 */
  colorFrom?: string;
  /** 渐变结束颜色 */
  colorTo?: string;
  /** 旋转周期（秒） */
  duration?: number;
  /** 边框粗细 */
  borderWidth?: number;
  className?: string;
}

/**
 * BorderBeam — 高性能 CSS 边框流光效果组件
 * 适用于盘中实时行情高亮，光束顺时针沿 Card 边框匀速流动。
 */
export function BorderBeam({
  colorFrom = '#3b82f6',
  colorTo = '#ef4444',
  duration = 4,
  borderWidth = 1.5,
  className = '',
}: BorderBeamProps) {
  return (
    <div
      className={`pointer-events-none absolute -inset-[1px] rounded-[inherit] overflow-hidden ${className}`}
      style={{ padding: `${borderWidth}px` }}
    >
      <div
        className="absolute inset-[-150%] animate-[spin_4s_linear_infinite]"
        style={{
          background: `conic-gradient(from 0deg at 50% 50%, transparent 0%, transparent 75%, ${colorFrom} 90%, ${colorTo} 100%)`,
          animationDuration: `${duration}s`,
        }}
      />
    </div>
  );
}
