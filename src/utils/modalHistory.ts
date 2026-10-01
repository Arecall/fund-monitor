import { useEffect, useRef, useCallback } from 'react';

/**
 * 移动端历史栈与 Android 物理返回/边缘侧滑手势统一协调器
 *
 * 核心特性：
 * 1. 后进先出 (LIFO Modal Stack) 管理多层嵌套弹窗与抽屉
 * 2. UI 主动关闭自动 rollback 历史记录，杜绝“空历史记录假死”
 * 3. popstate 回环阻断器，隔离主动回退与 Android 物理手势回退
 * 4. 纯净 URL 保障，不产生脏 URL 参数
 */

interface ModalStackEntry {
  id: string;
  onDismiss: () => void;
}

// 全局弹层栈与防回环计数
const modalStack: ModalStackEntry[] = [];
let ignorePopCount = 0;
let isInitialized = false;

function initGlobalHistoryListener(): void {
  if (typeof window === 'undefined' || isInitialized) return;
  isInitialized = true;

  // 清理初始化时残留的历史标记
  try {
    if (window.history.state && (window.history.state as Record<string, unknown>).__modal_id) {
      const cleanState = { ...window.history.state };
      delete (cleanState as Record<string, unknown>).__modal_id;
      window.history.replaceState(cleanState, '');
    }
  } catch (e) {
    // 忽略特定沙箱环境下的 replaceState 异常
  }

  window.addEventListener('popstate', () => {
    // 1. 如果此 popstate 是由 UI 主动关闭调用 history.back() 产生的，直接消耗计数并忽略
    if (ignorePopCount > 0) {
      ignorePopCount--;
      return;
    }

    // 2. 如果存在激活的弹层，说明这是 Android 物理返回键/边缘侧滑触发的真实返回
    if (modalStack.length > 0) {
      const top = modalStack.pop();
      if (top) {
        try {
          top.onDismiss();
        } catch (err) {
          console.error('[ModalHistory] Error during modal dismiss:', err);
        }
      }
    }
  });
}

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768 || ('ontouchstart' in window && window.innerWidth < 1024);
}

let nextId = 1;

/**
 * 为组件赋予 Android 物理返回 / 侧滑手势感知的自定义 Hook
 * 仅在移动端环境下启用虚拟历史记录拦截；PC 桌面端坚决不调用 pushState 与 history.back()，彻底隔离全局历史栈！
 *
 * @param isOpen 当前弹层/抽屉/二级视图是否处于展开状态
 * @param onDismiss 关闭回调函数（当用户按 Android 返回键或侧滑时触发）
 * @param options 配置项（如自定义 id、是否启用 enabled 等）
 */
export function useModalHistory(
  isOpen: boolean,
  onDismiss: () => void,
  options?: {
    id?: string;
    enabled?: boolean;
  }
): void {
  const isMobile = typeof window !== 'undefined' && isMobileDevice();
  const enabled = (options?.enabled ?? true) && isMobile;
  const idRef = useRef<string>(options?.id || `modal_${nextId++}`);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const isRegisteredRef = useRef(false);

  // 包装稳定的 dismiss 回调
  const handleDismiss = useCallback(() => {
    onDismissRef.current?.();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !enabled) return;
    initGlobalHistoryListener();

    const currentId = idRef.current;

    if (isOpen && enabled) {
      if (!isRegisteredRef.current) {
        // 压入全局管理栈
        modalStack.push({
          id: currentId,
          onDismiss: handleDismiss,
        });

        // 向浏览器历史压入一条虚拟记录，为 Android 拦截回退手势
        try {
          const currentState = window.history.state || {};
          window.history.pushState(
            { ...currentState, __modal_id: currentId },
            '',
            window.location.href
          );
        } catch (e) {
          // 容错处理
        }

        isRegisteredRef.current = true;
      }
    } else {
      // 弹层关闭阶段
      if (isRegisteredRef.current) {
        isRegisteredRef.current = false;

        // 检查该弹层是否还在栈中：
        // 如果还在栈中，说明是用户点击 UI 按钮主动关闭，需要主动后退一条历史以消除虚拟记录
        const stackIdx = modalStack.findIndex(item => item.id === currentId);
        if (stackIdx !== -1) {
          modalStack.splice(stackIdx, 1);
          ignorePopCount++;
          try {
            window.history.back();
          } catch (e) {
            ignorePopCount = Math.max(0, ignorePopCount - 1);
          }
        }
      }
    }

    return () => {
      // 组件卸载清理
      if (isRegisteredRef.current) {
        isRegisteredRef.current = false;
        const stackIdx = modalStack.findIndex(item => item.id === currentId);
        if (stackIdx !== -1) {
          modalStack.splice(stackIdx, 1);
          ignorePopCount++;
          try {
            window.history.back();
          } catch (e) {
            ignorePopCount = Math.max(0, ignorePopCount - 1);
          }
        }
      }
    };
  }, [isOpen, enabled, handleDismiss]);
}
