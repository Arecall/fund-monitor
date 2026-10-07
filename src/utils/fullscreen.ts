import { useState, useCallback, useEffect, useRef } from 'react';
import { useModalHistory } from './modalHistory';

export type FullscreenTrack = 'native' | 'virtual' | 'desktop-native' | 'none';

export interface DualTrackFullscreenOptions {
  modalId: string;
  onExit?: () => void;
}

/**
 * 设备全屏与方向能力探测
 * - iOS iPhone：WebKit 规范硬性限制，不允许通用 DOM 元素原生全屏，使用 90° 虚拟横屏 (virtual)
 * - Android 移动设备：支持 HTML5 Fullscreen API + Screen Orientation Lock，使用真沉浸式横屏 (native)
 * - 桌面端 / 平板宽屏：支持原生全屏，无需旋转 (desktop-native)
 */
export function detectBestFullscreenTrack(): FullscreenTrack {
  if (typeof window === 'undefined') return 'none';
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIPad = /iPad/i.test(ua) || (isIOS && !/iPhone/i.test(ua) && screen.width >= 768);
  const isIOSPhone = isIOS && !isIPad;

  // iOS iPhone 绝对无法调用 div 原生全屏，强制降级为虚拟横屏
  if (isIOSPhone) {
    return 'virtual';
  }

  const docEl = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
    mozRequestFullScreen?: () => Promise<void>;
    msRequestFullscreen?: () => Promise<void>;
  };

  const hasFullscreenAPI = Boolean(
    docEl.requestFullscreen ||
    docEl.webkitRequestFullscreen ||
    docEl.mozRequestFullScreen ||
    docEl.msRequestFullscreen
  );

  if (!hasFullscreenAPI) {
    return 'virtual';
  }

  const isTouch = 'ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
  const isMobileViewport = window.innerWidth < 1024 || (screen && Math.min(screen.width, screen.height) < 600);

  return (isTouch && isMobileViewport) ? 'native' : 'desktop-native';
}

/**
 * 双轨渐进增强全屏调度 Hook (Dual-Track Progressive Enhancement Fullscreen)
 *
 * 架构规范：
 * 1. 同步瞬态手势触发 (User Gesture Synchronous Invocations)
 * 2. 轨 1 (Android 移动端)：HTML5 Fullscreen API + screen.orientation.lock('landscape')
 * 3. 轨 2 (iOS iPhone / 沙盒 WebView)：CSS 90° 旋转 + 跨轴 Safe Area 映射
 * 4. 退出三路径统一收敛 (UI退出 / Android返回键 / 系统退出全屏)，杜绝历史栈回环
 */
export function useDualTrackFullscreen(options: DualTrackFullscreenOptions) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [track, setTrack] = useState<FullscreenTrack>('none');
  const isEnteringRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 1. 幂等退出全屏调度器
  const exitFullscreen = useCallback(async () => {
    isEnteringRef.current = false;

    // 释放屏幕方向锁定
    try {
      if (typeof screen !== 'undefined' && screen.orientation && 'unlock' in screen.orientation) {
        screen.orientation.unlock();
      }
    } catch (_) {
      // 忽略部分浏览器不支持 unlock 的异常
    }

    // 退出原生全屏
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element;
        webkitExitFullscreen?: () => Promise<void>;
        mozCancelFullScreen?: () => Promise<void>;
        msExitFullscreen?: () => Promise<void>;
      };
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) {
          await doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        }
      }
    } catch (_) {
      // 忽略已退出或异常
    }

    setIsFullscreen(false);
    setTrack('none');
    optionsRef.current.onExit?.();
  }, []);

  // 2. 幂等进入全屏调度器 (必须由用户物理点击/触碰直接同步调用)
  const requestFullscreen = useCallback(async () => {
    if (isFullscreen || isEnteringRef.current) return;
    isEnteringRef.current = true;
    const targetTrack = detectBestFullscreenTrack();

    if (targetTrack === 'native' || targetTrack === 'desktop-native') {
      try {
        const docEl = document.documentElement as HTMLElement & {
          webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
        };
        const requestFn = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
        if (requestFn) {
          await requestFn.call(docEl, { navigationUI: 'hide' });
        }

        // 移动端尝试将屏幕自动锁定为横屏
        if (targetTrack === 'native' && typeof screen !== 'undefined' && screen.orientation && 'lock' in screen.orientation) {
          try {
            await (screen.orientation as any).lock('landscape');
          } catch (_) {
            // 部分 Android 定制系统可能拒绝 orientation.lock，但原生全屏已生效，降级保留原生全屏
          }
        }

        setTrack(targetTrack);
        setIsFullscreen(true);
      } catch (err) {
        // 原生全屏被策略拦截时无缝降级为虚拟横屏
        setTrack('virtual');
        setIsFullscreen(true);
      } finally {
        isEnteringRef.current = false;
      }
    } else {
      // iOS iPhone 或不支持 DOM 原生全屏的环境直接走虚拟横屏
      setTrack('virtual');
      setIsFullscreen(true);
      isEnteringRef.current = false;
    }
  }, [isFullscreen]);

  // 3. 监听浏览器底层全屏状态变化 (如用户下拉状态栏点击退出全屏，或按 ESC 键)
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleFullscreenChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      const isCurrentlyFullscreen = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
      if (!isCurrentlyFullscreen && isFullscreen && (track === 'native' || track === 'desktop-native')) {
        void exitFullscreen();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, [isFullscreen, track, exitFullscreen]);

  // 4. 接入全局 LIFO 历史栈与 Android 物理返回键 / 边缘手势闭环
  useModalHistory(isFullscreen, exitFullscreen, { id: options.modalId });

  return {
    isFullscreen,
    track,
    requestFullscreen,
    exitFullscreen,
  };
}
