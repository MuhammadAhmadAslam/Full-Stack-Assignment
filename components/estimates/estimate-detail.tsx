'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { CheckCircle2, Pencil, RefreshCw, Send, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-config';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'rejected';
type LifecycleAction = 'send' | 'accept' | 'reject';

export interface EstimateDetailData {
  id: string;
  account_id: string;
  project_id: string | null;
  estimate_number: string;
  title: string;
  description: string | null;
  status: EstimateStatus;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  created_at: string;
  updated_at: string;
  line_items: Array<{
    id: string;
    description: string;
    quantity: string;
    unit_price_minor: number;
    amount_minor: number;
    sort_order: number;
  }>;
}

export interface EstimatePermissions {
  canEdit: boolean;
  canSend: boolean;
  canAccept: boolean;
  canReject: boolean;
}

const STATUS_META: Record<EstimateStatus, { label: string; variant: BadgeProps['variant'] }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  sent: { label: 'Sent', variant: 'default' },
  accepted: { label: 'Accepted', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
};

const ACTION_COPY: Record<
  LifecycleAction,
  { title: string; description: string; confirm: string; success: string }
> = {
  send: {
    title: 'Send this estimate?',
    description: 'The estimate will be marked as sent and can no longer be edited.',
    confirm: 'Send estimate',
    success: 'Estimate sent',
  },
  accept: {
    title: 'Accept this estimate?',
    description: 'Accepting is final — an accepted estimate cannot be changed.',
    confirm: 'Accept',
    success: 'Estimate accepted',
  },
  reject: {
    title: 'Reject this estimate?',
    description: 'Rejecting is final — a rejected estimate cannot be changed.',
    confirm: 'Reject',
    success: 'Estimate rejected',
  },
};

function formatMoney(minor: number, currency: string): string {
  const major = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, '0');
  try {
    return `${new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(major)}.${cents}`;
  } catch {
    return `${currency} ${major}.${cents}`;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatQuantity(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

async function fetcher(url: string): Promise<{ success: boolean; estimate: EstimateDetailData }> {
  const response = await apiFetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error ?? 'Failed to load estimate') as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body as { success: boolean; estimate: EstimateDetailData };
}

export function EstimateDetail({
  accountId,
  initial,
  projectName,
  permissions,
}: {
  accountId: string;
  initial: EstimateDetailData;
  projectName: string | null;
  permissions: EstimatePermissions;
}) {
  const key = `/api/estimates/${initial.id}?account_id=${accountId}`;
  const { data, error, isValidating, mutate } = useSWR(key, fetcher, {
    fallbackData: { success: true, estimate: initial },
    revalidateOnFocus: false,
  });

  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [busyAction, setBusyAction] = useState<LifecycleAction | null>(null);

  // The backend response is authoritative: the displayed state is whatever
  // the last fetch returned, never a client-side guess.
  const estimate = data?.estimate ?? initial;
  const meta = STATUS_META[estimate.status] ?? { label: estimate.status, variant: 'secondary' as const };

  const canEdit = estimate.status === 'draft' && permissions.canEdit;
  const canSend = estimate.status === 'draft' && permissions.canSend;
  const canAccept = estimate.status === 'sent' && permissions.canAccept;
  const canReject = estimate.status === 'sent' && permissions.canReject;
  const hasActions = canEdit || canSend || canAccept || canReject;

  const performAction = async (action: LifecycleAction) => {
    if (busyAction) return;
    setBusyAction(action);

    try {
      const response = await apiFetch(`/api/estimates/${estimate.id}/${action}`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error ?? 'Could not update the estimate');
        // Something changed underneath us (e.g. a concurrent transition):
        // re-read rather than trusting local state.
        await mutate();
        return;
      }

      toast.success(ACTION_COPY[action].success);
      setPendingAction(null);
      await mutate();
    } catch {
      toast.error('Network error. The estimate was not changed — please retry.');
      await mutate();
    } finally {
      setBusyAction(null);
    }
  };

  const requestAction = (action: LifecycleAction) => setPendingAction(action);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-mono text-sm">{estimate.estimate_number}</span>
            <Badge variant={meta.variant}>{meta.label}</Badge>
            <Badge variant="outline">{estimate.currency}</Badge>
            {isValidating && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Refreshing
              </span>
            )}
          </div>
          <h1 className="text-foreground truncate text-3xl font-bold sm:text-4xl">
            {estimate.title}
          </h1>
          {estimate.description && (
            <p className="text-muted-foreground max-w-2xl text-sm sm:text-base">
              {estimate.description}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canEdit && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/accounts/${accountId}/estimates/${estimate.id}/edit`}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit draft
              </Link>
            </Button>
          )}

          {canSend && (
            <Button
              type="button"
              size="sm"
              onClick={() => requestAction('send')}
              disabled={Boolean(busyAction)}
            >
              <Send className="mr-2 h-4 w-4" />
              Send
            </Button>
          )}

          {canAccept && (
            <Button
              type="button"
              size="sm"
              onClick={() => requestAction('accept')}
              disabled={Boolean(busyAction)}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Accept
            </Button>
          )}

          {canReject && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => requestAction('reject')}
              disabled={Boolean(busyAction)}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Reject
            </Button>
          )}
        </div>
      </div>

      {(estimate.status === 'accepted' || estimate.status === 'rejected') && (
        <p className="text-muted-foreground text-sm">
          This estimate is {estimate.status} and cannot be changed further.
        </p>
      )}

      {!hasActions && estimate.status === 'sent' && (
        <p className="text-muted-foreground text-sm">
          You don&apos;t have permission to accept or reject this estimate.
        </p>
      )}

      {error && (
        <div role="alert" className="border-destructive/30 bg-destructive/5 rounded-lg border p-3 text-sm">
          The latest version could not be loaded. Showing the last known state.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Line items</CardTitle>
            <CardDescription>{estimate.line_items.length} line(s)</CardDescription>
          </CardHeader>
          <CardContent>
            {estimate.line_items.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                This estimate has no line items.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Unit price</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {estimate.line_items.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="max-w-[320px] truncate">{line.description}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQuantity(line.quantity)}
                      </TableCell>
                      <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                        {formatMoney(line.unit_price_minor, estimate.currency)}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                        {formatMoney(line.amount_minor, estimate.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.subtotal_minor, estimate.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Tax</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.tax_minor, estimate.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t pt-3 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.total_minor, estimate.currency)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Project</span>
                <span className="truncate text-right">{projectName ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Currency</span>
                <span>{estimate.currency}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(estimate.created_at)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Updated</span>
                <span>{formatDate(estimate.updated_at)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction ? ACTION_COPY[pendingAction].title : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction ? ACTION_COPY[pendingAction].description : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyAction)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyAction)}
              onClick={(event) => {
                event.preventDefault();
                if (pendingAction) void performAction(pendingAction);
              }}
            >
              {busyAction ? 'Working…' : pendingAction ? ACTION_COPY[pendingAction].confirm : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
