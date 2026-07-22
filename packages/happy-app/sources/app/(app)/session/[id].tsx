import * as React from 'react';
import { useLocalSearchParams } from "expo-router";
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const { id } = useLocalSearchParams<{ id: string }>();
    return (<SessionView id={id!} />);
});