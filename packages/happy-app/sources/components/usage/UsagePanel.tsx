import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { UsageChart } from './UsageChart';
import { UsageBar } from './UsageBar';
import { getUsageForPeriod, calculateTotals, groupUsageBySource, getUsageKeyDisplay, UsageDataPoint, SNAPSHOT_KEYS } from '@/sync/apiUsage';
import { Ionicons } from '@expo/vector-icons';
import { HappyError } from '@/utils/errors';
import { t, type TranslationKey } from '@/text';

type TimePeriod = 'today' | '7days' | '30days';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    periodSelector: {
        flexDirection: 'row',
        padding: 16,
        gap: 8,
    },
    periodButton: {
        flex: 1,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
    },
    periodButtonActive: {
        backgroundColor: '#007AFF',
    },
    periodText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    periodTextActive: {
        color: '#FFFFFF',
    },
    statsContainer: {
        padding: 16,
        backgroundColor: theme.colors.surface,
        margin: 16,
        borderRadius: 12,
        gap: 12,
    },
    statRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    statLabel: {
        fontSize: 16,
        color: theme.colors.text,
    },
    statValue: {
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
    },
    chartSection: {
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    errorContainer: {
        padding: 32,
        alignItems: 'center',
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.status.error,
        textAlign: 'center',
    },
    metricToggle: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 16,
        padding: 16,
    },
    metricButton: {
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderRadius: 16,
        backgroundColor: theme.colors.divider,
    },
    metricButtonActive: {
        backgroundColor: '#007AFF',
    },
    metricText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    metricTextActive: {
        color: '#FFFFFF',
    },
    debugJson: {
        fontFamily: 'monospace',
        fontSize: 11,
        color: theme.colors.textSecondary,
        padding: 12,
        maxHeight: 320,
    },
}));

export const UsagePanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [period, setPeriod] = useState<TimePeriod>('7days');
    const [chartMetric, setChartMetric] = useState<'tokens' | 'cost'>('tokens');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [usageData, setUsageData] = useState<UsageDataPoint[]>([]);
    const [totals, setTotals] = useState({
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>
    });
    const [showDebug, setShowDebug] = useState(false);
    const [rawDebug, setRawDebug] = useState<{ usage: UsageDataPoint[]; totals: typeof totals } | null>(null);
    
    useEffect(() => {
        loadUsageData();
    }, [period, sessionId]);
    
    const loadUsageData = async () => {
        if (!auth.credentials) {
            setError('Not authenticated');
            return;
        }
        
        setLoading(true);
        setError(null);
        
        try {
            const response = await getUsageForPeriod(auth.credentials, period, sessionId);
            const usage = response.usage || [];
            setUsageData(usage);
            const nextTotals = calculateTotals(usage);
            setTotals(nextTotals);
            setRawDebug({ usage, totals: nextTotals });
        } catch (err) {
            console.error('Failed to load usage data:', err);
            if (err instanceof HappyError) {
                setError(err.message);
            } else {
                setError('Failed to load usage data');
            }
        } finally {
            setLoading(false);
        }
    };
    
    const formatTokens = (tokens: number): string => {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(2)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toLocaleString();
    };
    
    const formatCost = (cost: number): string => {
        return `$${cost.toFixed(4)}`;
    };
    
    const periodLabels: Record<TimePeriod, string> = {
        'today': t('usage.today'),
        '7days': t('usage.last7Days'),
        '30days': t('usage.last30Days')
    };
    
    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }
    
    if (error) {
        return (
            <View style={styles.errorContainer}>
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.status.error} />
                <Text style={styles.errorText}>{error}</Text>
            </View>
        );
    }
    
    // Group token and cost breakdown by source (Claude / Cursor) with friendly labels
    const tokenGroups = groupUsageBySource(totals.tokensByModel);
    const costGroups = groupUsageBySource(totals.costByModel);
    // Support both legacy key names (installed binary) and new key names (wip source).
    const onDemandUsed: number | null =
        totals.costByModel['on_demand_used_cents'] ??
        totals.costByModel['on_demand_cents'] ??
        null;
    const onDemandLimit: number | null =
        totals.costByModel['on_demand_limit_cents'] ??
        totals.costByModel['on_demand_limit'] ??
        null;
    // Plan is stored under tokens (cents), pulled out separately for cost display.
    const planUsedCents: number | null =
        totals.tokensByModel['plan_requests_used'] ??
        totals.tokensByModel['plan_used'] ??
        null;
    const planLimitCents: number | null =
        totals.tokensByModel['plan_requests_limit'] ??
        totals.tokensByModel['plan_limit'] ??
        null;

    // Keys hidden from the token breakdown: plan (cents, shown in cost section + summary)
    // and limit/remaining keys (implicit from the bar's maxValue).
    const HIDDEN_BREAKDOWN_KEYS = new Set([
        // plan – moved to cost section
        'plan_used', 'plan_requests_used',
        'plan_limit', 'plan_requests_limit',
        'plan_requests_remaining',
        // on-demand limits/remaining
        'on_demand_limit', 'on_demand_remaining',
        'on_demand_limit_cents',
    ]);

    // Max is calculated per unit type: exclude SNAPSHOT_KEYS so Cursor request counts
    // don't pollute the Claude token scale (and vice-versa for costs).
    const maxTokenInGroups = Math.max(
        ...tokenGroups.flatMap((g) => g.entries.filter(([k]) => !SNAPSHOT_KEYS.has(k)).map(([, v]) => v)),
        1
    );
    const maxCostInGroups = Math.max(
        ...costGroups.flatMap((g) => g.entries.filter(([k]) => !SNAPSHOT_KEYS.has(k)).map(([, v]) => v)),
        1
    );
    const planLimit =
        totals.tokensByModel['plan_requests_limit'] ??
        totals.tokensByModel['plan_limit'] ??
        null;
    const onDemandCostLimit =
        totals.costByModel['on_demand_limit_cents'] ??
        totals.costByModel['on_demand_limit'] ??
        null;

    /** Cursor plan requests: use plan limit so the bar shows "X of Y requests used". */
    const tokenBarMax = (key: string) =>
        (key === 'plan_requests_used' || key === 'plan_used') && planLimit !== null
            ? planLimit
            : maxTokenInGroups;
    /** Cursor on-demand cents: use cent limit so the bar shows real spend %. */
    const costBarMax = (key: string) =>
        (key === 'on_demand_cents' || key === 'on_demand_used_cents') && onDemandCostLimit !== null
            ? onDemandCostLimit
            : maxCostInGroups;

    const isCursorPlanUsedKey = (key: string) => key === 'plan_requests_used' || key === 'plan_used';
    const isCursorOnDemandCentsKey = (key: string) => key === 'on_demand_cents' || key === 'on_demand_used_cents';

    /** Value label for a token bar entry. Plan values are in cents, same as on-demand. */
    const formatTokenValue = (key: string) => (value: number, percentage: number): string => {
        if (isCursorPlanUsedKey(key)) {
            const pct = planLimit !== null && planLimit > 0 ? ` (${percentage.toFixed(0)}%)` : '';
            return `$${(value / 100).toFixed(2)}${pct}`;
        }
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
        return value.toLocaleString();
    };
    /** Value label for a cost bar entry. Cursor on-demand values are in cents → convert to $. */
    const formatCostBarValue = (key: string) => (value: number, percentage: number): string => {
        if (isCursorOnDemandCentsKey(key)) {
            const pct = onDemandCostLimit !== null && onDemandCostLimit > 0 ? ` (${percentage.toFixed(0)}%)` : '';
            return `$${(value / 100).toFixed(2)}${pct}`;
        }
        return `$${value.toFixed(4)}`;
    };

    const sectionTitleBySource: Record<string, string> = {
        claude: t('usage.sectionClaude'),
        cursor: t('usage.sectionCursor'),
        other: t('usage.sectionOther'),
    };

    return (
        <ScrollView style={styles.container}>
            {/* Period Selector */}
            <View style={styles.periodSelector}>
                {(['today', '7days', '30days'] as TimePeriod[]).map((p) => (
                    <Pressable
                        key={p}
                        style={[styles.periodButton, period === p && styles.periodButtonActive]}
                        onPress={() => setPeriod(p)}
                    >
                        <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
                            {periodLabels[p]}
                        </Text>
                    </Pressable>
                ))}
            </View>
            
            {/* Summary Stats */}
            <View style={styles.statsContainer}>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('usage.totalTokens')}</Text>
                    <Text style={styles.statValue}>{formatTokens(totals.totalTokens)}</Text>
                </View>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('usage.totalCost')}</Text>
                    <Text style={styles.statValue}>{formatCost(totals.totalCost)}</Text>
                </View>
                {planUsedCents !== null && (
                    <View style={styles.statRow}>
                        <Text style={styles.statLabel}>{t('usage.keyCursorPlanUsed')}</Text>
                        <Text style={[styles.statValue, { color: '#6366F1' }]}>
                            {`$${(planUsedCents / 100).toFixed(2)}`}
                            {planLimitCents !== null ? ` / $${(planLimitCents / 100).toFixed(2)}` : ''}
                        </Text>
                    </View>
                )}
                {onDemandUsed !== null && (
                    <View style={styles.statRow}>
                        <Text style={styles.statLabel}>{t('usage.keyCursorOnDemandCents')}</Text>
                        <Text style={[styles.statValue, { color: '#6366F1' }]}>
                            {`$${(onDemandUsed / 100).toFixed(2)}`}
                            {onDemandLimit !== null ? ` / $${(onDemandLimit / 100).toFixed(2)}` : ''}
                        </Text>
                    </View>
                )}
            </View>
            
            {/* Usage Chart */}
            {usageData.length > 0 && (
                <View style={styles.chartSection}>
                    <Text style={styles.sectionTitle}>{t('usage.usageOverTime')}</Text>
                    
                    {/* Metric Toggle */}
                    <View style={styles.metricToggle}>
                        <Pressable
                            style={[styles.metricButton, chartMetric === 'tokens' && styles.metricButtonActive]}
                            onPress={() => setChartMetric('tokens')}
                        >
                            <Text style={[styles.metricText, chartMetric === 'tokens' && styles.metricTextActive]}>
                                {t('usage.tokens')}
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[styles.metricButton, chartMetric === 'cost' && styles.metricButtonActive]}
                            onPress={() => setChartMetric('cost')}
                        >
                            <Text style={[styles.metricText, chartMetric === 'cost' && styles.metricTextActive]}>
                                {t('usage.cost')}
                            </Text>
                        </Pressable>
                    </View>
                    
                    <UsageChart 
                        data={usageData}
                        metric={chartMetric}
                        height={180}
                    />
                </View>
            )}
            
            {/* Usage by source (Claude tokens / Cursor requests) */}
            <ItemGroup title={t('usage.bySource')}>
                <View style={{ padding: 16 }}>
                    {tokenGroups.length > 0 ? (
                        tokenGroups.map(({ source, entries }) => {
                            const visible = entries.filter(([k]) => !HIDDEN_BREAKDOWN_KEYS.has(k));
                            if (visible.length === 0) return null;
                            return (
                                <View key={source} style={{ marginBottom: 16 }}>
                                    <Text style={[styles.sectionTitle, { marginHorizontal: 0, marginBottom: 8 }]}>
                                        {sectionTitleBySource[source]}
                                    </Text>
                                    {visible.map(([key, value]) => (
                                        <UsageBar
                                            key={key}
                                            label={t(getUsageKeyDisplay(key).labelKey as TranslationKey)}
                                            value={value}
                                            maxValue={tokenBarMax(key)}
                                            color={source === 'cursor' ? '#6366F1' : '#007AFF'}
                                            formatValue={formatTokenValue(key)}
                                        />
                                    ))}
                                </View>
                            );
                        })
                    ) : (
                        <Text style={styles.statLabel}>{t('usage.noBreakdown')}</Text>
                    )}
                </View>
            </ItemGroup>

            {/* Cost by source (Claude $ / Cursor plan ¢ / Cursor on-demand ¢) */}
            <ItemGroup title={t('usage.cost')}>
                <View style={{ padding: 16 }}>
                    {/* Cursor plan bar (data lives in tokensByModel but unit is cents) */}
                    {planUsedCents !== null && (
                        <View style={{ marginBottom: 16 }}>
                            <Text style={[styles.sectionTitle, { marginHorizontal: 0, marginBottom: 8 }]}>
                                {sectionTitleBySource['cursor']}
                            </Text>
                            <UsageBar
                                label={t('usage.keyCursorPlanUsed')}
                                value={planUsedCents}
                                maxValue={planLimitCents ?? planUsedCents}
                                color='#6366F1'
                                formatValue={formatCostBarValue('on_demand_used_cents')}
                            />
                            {onDemandUsed !== null && (
                                <UsageBar
                                    label={t('usage.keyCursorOnDemandCents')}
                                    value={onDemandUsed}
                                    maxValue={onDemandLimit ?? onDemandUsed}
                                    color='#6366F1'
                                    formatValue={formatCostBarValue('on_demand_used_cents')}
                                />
                            )}
                        </View>
                    )}
                    {costGroups.map(({ source, entries }) => {
                        // Cursor on-demand already rendered above alongside plan
                        if (source === 'cursor') return null;
                        const visible = entries.filter(([k]) => !HIDDEN_BREAKDOWN_KEYS.has(k));
                        if (visible.length === 0) return null;
                        return (
                            <View key={`cost-${source}`} style={{ marginBottom: 16 }}>
                                <Text style={[styles.sectionTitle, { marginHorizontal: 0, marginBottom: 8 }]}>
                                    {sectionTitleBySource[source]}
                                </Text>
                                {visible.map(([key, value]) => (
                                    <UsageBar
                                        key={key}
                                        label={t(getUsageKeyDisplay(key).labelKey as TranslationKey)}
                                        value={value}
                                        maxValue={costBarMax(key)}
                                        color='#FF9500'
                                        formatValue={formatCostBarValue(key)}
                                    />
                                ))}
                            </View>
                        );
                    })}
                    {planUsedCents === null && costGroups.every(({ entries }) =>
                        entries.filter(([k]) => !HIDDEN_BREAKDOWN_KEYS.has(k)).length === 0
                    ) && (
                        <Text style={styles.statLabel}>{t('usage.noBreakdown')}</Text>
                    )}
                </View>
            </ItemGroup>

            {/* Debug: raw JSON */}
            <ItemGroup title="Debug">
                <Pressable onPress={() => setShowDebug((v) => !v)} style={{ padding: 16 }}>
                    <Text style={styles.statLabel}>
                        {showDebug ? 'Hide raw JSON' : 'Show raw JSON'}
                    </Text>
                </Pressable>
                {showDebug && rawDebug !== null && (
                    <ScrollView
                        style={styles.debugJson}
                        nestedScrollEnabled
                        contentContainerStyle={{ paddingBottom: 16 }}
                    >
                        <Text selectable style={styles.debugJson}>
                            {JSON.stringify(rawDebug, null, 2)}
                        </Text>
                    </ScrollView>
                )}
            </ItemGroup>
        </ScrollView>
    );
};