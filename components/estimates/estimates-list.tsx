'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { FileText, Plus, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api-config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

interface EstimateListItem {
  id: string;
  estimate_number: string;
  title: string;
  project_id: string | null;
  project_name?: string | null;
  currency: string;
  status: EstimateStatus;
  total_minor: number;
  created_at: string;
}

interface EstimatesResponse {
  success: boolean;
  estimates: EstimateListItem[];
  pagination: {
    count: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

const PAGE_SIZE = 10;

const STATUS_OPTIONS: Array<{ value: 'all' | EstimateStatus; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
];

const STATUS_META: Record<EstimateStatus, { label: string; variant: BadgeProps['variant'] }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  sent: { label: 'Sent', variant: 'default' },
  accepted: { label: 'Accepted', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
};

async function fetcher(url: string): Promise<EstimatesResponse> {
  const response = await apiFetch(url);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      body?.error || 'Failed to load estimates',
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return body as EstimatesResponse;
}

function formatMoney(minor: number, currency: string): string {
  if (!Number.isFinite(minor)) return '—';

  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const amount = Math.floor(absolute / 100) + (absolute % 100) / 100;
  const signed = negative ? -amount : amount;

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(signed);
  } catch {
    return `${currency} ${signed.toFixed(2)}`;
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

export function EstimatesList({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState<'all' | EstimateStatus>('all');
  const [offset, setOffset] = useState(0);

  // A new account (or filter) always starts at the first page; the SWR key
  // also changes with the account, so data from the previous account is never
  // shown while the new one loads.
  useEffect(() => {
    setOffset(0);
  }, [accountId, status]);

  const key = useMemo(() => {
    const params = new URLSearchParams({
      account_id: accountId,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort: 'created_at',
      direction: 'desc',
    });
    if (status !== 'all') params.set('status', status);
    return `/api/estimates?${params.toString()}`;
  }, [accountId, status, offset]);

  const { data, error, isLoading, mutate } = useSWR<EstimatesResponse>(key, fetcher, {
    keepPreviousData: false,
    revalidateOnFocus: false,
  });

  const estimates = data?.estimates ?? [];
  const pagination = data?.pagination;
  const total = pagination?.count ?? 0;
  const canGoBack = offset > 0;
  const canGoForward = pagination?.has_more ?? false;

  const errorMessage = (() => {
    if (!error) return null;
    const statusCode = (error as Error & { status?: number }).status;
    if (statusCode === 401) return 'Please sign in again to view estimates.';
    if (statusCode === 403) return 'You do not have access to estimates for this account.';
    if (statusCode === 404) return 'This account could not be found.';
    return error.message || 'Something went wrong while loading estimates.';
  })();

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
              <FileText className="h-5 w-5" />
              Estimates
            </CardTitle>
            <CardDescription className="mt-1">
              {pagination
                ? `${total} ${total === 1 ? 'estimate' : 'estimates'} in this account`
                : 'Loading estimates…'}
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as 'all' | EstimateStatus)}
            >
              <SelectTrigger size="sm" className="w-[160px]" aria-label="Filter by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void mutate()}
              disabled={isLoading}
              aria-label="Refresh estimates"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>

            <Button asChild size="sm">
              <Link href={`/accounts/${accountId}/estimates/new`}>
                <Plus className="mr-2 h-4 w-4" />
                New estimate
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {isLoading && !data ? (
          <div className="space-y-2" aria-busy="true" aria-live="polite">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : errorMessage ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-xl border p-6"
          >
            <p className="text-foreground text-sm font-medium">{errorMessage}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void mutate()}>
              Try again
            </Button>
          </div>
        ) : estimates.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center">
            <FileText className="text-muted-foreground h-8 w-8" />
            <p className="text-foreground text-sm font-medium">No estimates found</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              {status === 'all'
                ? 'Estimates created for this account will appear here.'
                : 'No estimates match this status. Try a different filter.'}
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estimate #</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden md:table-cell">Project</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {estimates.map((estimate) => {
                  const meta = STATUS_META[estimate.status] ?? {
                    label: estimate.status,
                    variant: 'secondary' as const,
                  };

                  return (
                    <TableRow key={estimate.id}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <Link
                          href={`/accounts/${accountId}/estimates/${estimate.id}`}
                          className="text-foreground hover:text-primary underline-offset-4 hover:underline"
                        >
                          {estimate.estimate_number}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">{estimate.title}</TableCell>
                      <TableCell className="text-muted-foreground hidden max-w-[180px] truncate md:table-cell">
                        {estimate.project_name || '—'}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {formatMoney(estimate.total_minor, estimate.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden whitespace-nowrap sm:table-cell">
                        {formatDate(estimate.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <p className="text-muted-foreground text-sm">
                Showing {offset + 1}–{offset + estimates.length} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canGoBack}
                  onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canGoForward}
                  onClick={() => setOffset((current) => current + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
