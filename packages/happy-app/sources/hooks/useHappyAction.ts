import * as React from 'react';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors';

export function useHappyAction<T extends any[] = []>(action: (...args: T) => Promise<void>) {
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);
    const doAction = React.useCallback((...args: T) => {
        if (loadingRef.current) {
            return;
        }
        loadingRef.current = true;
        setLoading(true);
        (async () => {
            try {
                while (true) {
                    try {
                        await action(...args);
                        break;
                    } catch (e) {
                        if (e instanceof HappyError) {
                            // if (e.canTryAgain) {
                            //     Modal.alert('Error', e.message, [{ text: 'Try again' }, { text: 'Cancel', style: 'cancel' }]) 
                            //         break;
                            //     }
                            // } else {
                            //     await alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                            //     break;
                            // }
                            Modal.alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                            break;
                        } else {
                            Modal.alert('Error', 'Unknown error', [{ text: 'OK', style: 'cancel' }]);
                            break;
                        }
                    }
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
            }
        })();
    }, [action]);
    return [loading, doAction] as const;
}