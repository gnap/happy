import React from 'react'
import { CodexDisplay } from './CodexDisplay'
import { type MessageBuffer } from './messageBuffer'

interface CursorDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
}

export const CursorDisplay: React.FC<CursorDisplayProps> = (props) => {
    return <CodexDisplay {...props} agentLabel="Cursor" />
}
