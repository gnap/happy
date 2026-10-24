import { useRouter } from "expo-router"
import { log } from '@/log';

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        // Paired with the session screen's own mount/focus log, this is the tap-to-screen time —
        // the half of "slow" that neither hydration nor the network can explain.
        log.log(`👆 open session requested: ${sessionId}`);
        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session'
            },
        });
    }
}