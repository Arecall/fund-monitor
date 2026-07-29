import { useState, useEffect, useCallback } from 'react';

export type AppEnv = 'dev' | 'prod';

const STORAGE_KEY = 'fund_app_env';

/**
 * 获取当前应用环境
 * 默认使用 localStorage 中存储的值；若无存储则优先取 Vite 的 import.meta.env.DEV (DEV -> dev, PROD -> prod)
 */
export function getAppEnv(): AppEnv {
  return 'prod';
}

/**
 * 切换环境并广播状态变化
 */
export function setAppEnv(env: AppEnv) {
  try {
    localStorage.setItem(STORAGE_KEY, env);
    window.dispatchEvent(new Event('app_env_change'));
  } catch {}
}

/**
 * React Hook: 实时响应环境切换
 */
export function useAppEnv(): { env: AppEnv; setEnv: (env: AppEnv) => void; isDev: boolean } {
  const [env, setEnvState] = useState<AppEnv>(() => getAppEnv());

  useEffect(() => {
    const handler = () => {
      setEnvState(getAppEnv());
    };
    window.addEventListener('app_env_change', handler);
    return () => window.removeEventListener('app_env_change', handler);
  }, []);

  const setEnv = useCallback((nextEnv: AppEnv) => {
    setAppEnv(nextEnv);
  }, []);

  return { env, setEnv, isDev: env === 'dev' };
}
