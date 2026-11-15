import { ActionExecutor } from './actionExecutor.ts';

if (typeof window !== 'undefined') {
  (window as any).ActionExecutor = (window as any).ActionExecutor || ActionExecutor;
  (window as any).actionExecutorInstance = (window as any).actionExecutorInstance || new ActionExecutor();
  (window as any).actionExecutor = (window as any).actionExecutor || (window as any).actionExecutorInstance;
}
