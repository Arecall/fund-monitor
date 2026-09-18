interface QuantLogoProps {
  size?: number;
  className?: string;
}

/**
 * 全球量化基金平台官方品牌标识 (Official Vector Brand Logo)
 * 融合量化动量阶梯柱 (Quant Momentum Bars)、Alpha上升趋势线与高亮星芒
 */
export function QuantLogo({ size = 28, className = '' }: QuantLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 transition-transform duration-200 hover:scale-105 select-none ${className}`}
      aria-label="全球量化基金平台 Logo"
    >
      <defs>
        {/* 背景渐变：深邃科技暗夜蓝紫 */}
        <linearGradient id="qf-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e1b4b" />
          <stop offset="50%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>

        {/* 趋势线渐变：亮蓝 -> 靛紫 -> 翡翠绿 (Alpha超额收益曲线) */}
        <linearGradient id="qf-logo-trend" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="50%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>

        {/* 量化动量柱立体渐变 */}
        <linearGradient id="qf-logo-bar1" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#2563eb" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="qf-logo-bar2" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="qf-logo-bar3" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#34d399" stopOpacity="1" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.35" />
        </linearGradient>

        {/* 微发光滤镜 */}
        <filter id="qf-logo-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* 外层 Squircle 科技底座（带微发光外边框与轻质感阴影） */}
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="8"
        fill="url(#qf-logo-bg)"
        stroke="rgba(255, 255, 255, 0.15)"
        strokeWidth="1"
      />

      {/* 量化动量阶梯柱 (Quant Factor Columns) */}
      <rect x="7" y="16.5" width="3.5" height="8.5" rx="1.5" fill="url(#qf-logo-bar1)" />
      <rect x="13" y="12.5" width="3.5" height="12.5" rx="1.5" fill="url(#qf-logo-bar2)" />
      <rect x="19" y="8" width="3.5" height="17" rx="1.5" fill="url(#qf-logo-bar3)" />

      {/* 向上突破的量化 Alpha 收益折线 (Alpha Curve) */}
      <path
        d="M6 20.5C9.5 17.5 11.5 16 14.5 13C17.5 10 19.5 10.5 25.5 6"
        stroke="url(#qf-logo-trend)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#qf-logo-glow)"
      />

      {/* 突破峰值发光星斑 (Pinnacle Point) */}
      <circle cx="25.5" cy="6" r="4" fill="#34d399" opacity="0.3" />
      <circle cx="25.5" cy="6" r="2.2" fill="#34d399" />
      <circle cx="25.5" cy="6" r="0.9" fill="#ffffff" />
    </svg>
  );
}

export default QuantLogo;
