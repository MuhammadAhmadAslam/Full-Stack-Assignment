'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-config';
import {
  computeEstimate,
  computeLineAmountMinor,
  parseQuantityToMilli,
  MAX_TAX_RATE_BPS,
} from '@/lib/estimate-money';
import { parseMajorToMinor, parsePercentToBasisPoints, formatMinorToMajor } from '@/lib/money-input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ProjectOption {
  id: string;
  name: string;
}

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

let lineCounter = 0;

function newLine(): LineDraft {
  lineCounter += 1;
  return { key: `line-${lineCounter}`, description: '', quantity: '1', unitPrice: '' };
}

function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `est-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function generateEstimateNumber(): string {
  return `EST-${Date.now().toString(36).toUpperCase()}`;
}

/** Display only — URLs/money never pass through here. */
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

export interface EstimateFormInitial {
  estimate_number: string;
  title: string;
  description: string | null;
  currency: string;
  project_id: string | null;
  tax_minor: number;
  line_items: Array<{ description: string; quantity: string; unit_price_minor: number }>;
}

export function EstimateForm({
  accountId,
  accountName,
  projects,
  mode = 'create',
  estimateId,
  initial,
}: {
  accountId: string;
  accountName: string;
  projects: ProjectOption[];
  mode?: 'create' | 'edit';
  estimateId?: string;
  initial?: EstimateFormInitial;
}) {
  const router = useRouter();

  const [estimateNumber, setEstimateNumber] = useState(initial?.estimate_number ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD');
  const [projectId, setProjectId] = useState(initial?.project_id ?? 'none');
  const [taxRate, setTaxRate] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() => {
    if (initial?.line_items && initial.line_items.length > 0) {
      return initial.line_items.map((line) => {
        lineCounter += 1;
        return {
          key: `line-${lineCounter}`,
          description: line.description,
          quantity: line.quantity,
          unitPrice: formatMinorToMajor(line.unit_price_minor),
        };
      });
    }
    return [newLine()];
  });

  const isEdit = mode === 'edit' && Boolean(estimateId);
  const initialTaxMinor = initial?.tax_minor ?? 0;

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverDetails, setServerDetails] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Same key for the same payload, a new key when the payload changes. A
  // failed attempt is retried with the SAME key, so it cannot create twice.
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    if (mode === 'create') {
      setEstimateNumber((current) => current || generateEstimateNumber());
    }
  }, [mode]);

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const moveLine = (index: number, direction: -1 | 1) => {
    setLines((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // Preview only: same float-free helpers as the server, but the server
  // recalculates and stores the authoritative totals.
  const lineAmounts = useMemo(() => {
    const amounts = new Map<string, number | null>();
    for (const line of lines) {
      const quantity = parseQuantityToMilli(line.quantity);
      const price = parseMajorToMinor(line.unitPrice);
      if (!quantity.ok || !price.ok) {
        amounts.set(line.key, null);
        continue;
      }
      const amount = computeLineAmountMinor(quantity.value, price.value);
      amounts.set(line.key, amount.ok ? Number(amount.value) : null);
    }
    return amounts;
  }, [lines]);

  const previewTotals = useMemo(() => {
    const tax = parsePercentToBasisPoints(taxRate);
    if (!tax.ok || tax.value > MAX_TAX_RATE_BPS) return null;

    const inputs = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const quantity = parseQuantityToMilli(line.quantity);
      const price = parseMajorToMinor(line.unitPrice);
      if (!quantity.ok || !price.ok) return null;
      inputs.push({
        description: line.description.trim() || `Line ${index + 1}`,
        quantity: line.quantity.trim(),
        unit_price_minor: price.value,
        sort_order: index,
      });
    }

    const result = computeEstimate(inputs, { taxRateBps: tax.value });
    return result.ok ? result.value.totals : null;
  }, [lines, taxRate]);

  const displayCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const errors: Record<string, string> = {};

    const trimmedNumber = estimateNumber.trim();
    if (!trimmedNumber) errors.estimate_number = 'Estimate number is required';
    else if (trimmedNumber.length > 64) errors.estimate_number = 'Estimate number is too long';

    const trimmedTitle = title.trim();
    if (!trimmedTitle) errors.title = 'Title is required';
    else if (trimmedTitle.length > 200) errors.title = 'Title is too long (max 200)';

    if (description.length > 5000) errors.description = 'Description is too long (max 5000)';

    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      errors.currency = 'Use a 3-letter currency code such as USD';
    }

    const tax = parsePercentToBasisPoints(taxRate);
    if (!tax.ok) errors.tax_rate = tax.error;

    const payloadLines = lines.map((line, index) => {
      const lineDescription = line.description.trim();
      if (!lineDescription) {
        errors[`line_${index}_description`] = 'Description is required';
      } else if (lineDescription.length > 500) {
        errors[`line_${index}_description`] = 'Description is too long (max 500)';
      }

      const quantity = parseQuantityToMilli(line.quantity);
      if (!quantity.ok) errors[`line_${index}_quantity`] = quantity.error.message;

      const price = parseMajorToMinor(line.unitPrice);
      if (!price.ok) errors[`line_${index}_unit_price`] = price.error;

      return {
        description: lineDescription,
        quantity: line.quantity.trim(),
        unit_price_minor: price.ok ? price.value : 0,
        sort_order: index,
      };
    });

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('Please fix the highlighted fields');
      return;
    }

    // Draft editing goes through PATCH, which recalculates totals and only
    // accepts draft rows.
    if (isEdit && estimateId) {
      const updateBody = {
        estimate_number: trimmedNumber,
        title: trimmedTitle,
        description: description.trim() ? description.trim() : null,
        currency: currency.trim().toUpperCase(),
        project_id: projectId === 'none' ? null : projectId,
        line_items: payloadLines,
        ...(taxRate.trim() !== ''
          ? { tax_rate_bps: tax.ok ? tax.value : 0 }
          : initialTaxMinor > 0
            ? { tax_minor: initialTaxMinor }
            : {}),
      };

      setIsSubmitting(true);
      setServerError(null);
      setServerDetails([]);

      try {
        const response = await apiFetch(`/api/estimates/${estimateId}`, {
          method: 'PATCH',
          body: JSON.stringify(updateBody),
        });
        const result = await response.json().catch(() => null);

        if (!response.ok) {
          const details = Array.isArray(result?.details)
            ? result.details.map(
                (detail: { field?: string; message?: string }) =>
                  `${detail.field ?? 'body'}: ${detail.message ?? 'invalid'}`,
              )
            : [];
          setServerError(result?.error || 'The estimate could not be saved.');
          setServerDetails(details);
          toast.error(result?.error || 'The estimate could not be saved.');
          return;
        }

        toast.success('Draft estimate updated');
        router.push(`/accounts/${accountId}/estimates/${estimateId}`);
        router.refresh();
      } catch {
        setServerError('Network error. Your changes were not saved — please retry.');
        toast.error('Network error. Your changes were not saved.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const body = {
      account_id: accountId,
      estimate_number: trimmedNumber,
      title: trimmedTitle,
      description: description.trim() ? description.trim() : null,
      currency: currency.trim().toUpperCase(),
      ...(projectId !== 'none' ? { project_id: projectId } : {}),
      line_items: payloadLines,
      ...(tax.ok && tax.value > 0 ? { tax_rate_bps: tax.value } : {}),
    };

    const fingerprint = JSON.stringify(body);
    if (!idempotencyRef.current || idempotencyRef.current.fingerprint !== fingerprint) {
      idempotencyRef.current = { fingerprint, key: createIdempotencyKey() };
    }
    const idempotencyKey = idempotencyRef.current.key;

    setIsSubmitting(true);
    setServerError(null);
    setServerDetails([]);

    try {
      const response = await apiFetch('/api/estimates', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: fingerprint,
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        // A 409 means this key can no longer be reused; the next attempt
        // gets a fresh key (and the same payload edit changes the hash).
        if (response.status === 409) idempotencyRef.current = null;

        const details = Array.isArray(result?.details)
          ? result.details.map(
              (detail: { field?: string; message?: string }) =>
                `${detail.field ?? 'body'}: ${detail.message ?? 'invalid'}`,
            )
          : [];

        setServerError(result?.error || 'The estimate could not be created.');
        setServerDetails(details);
        toast.error(result?.error || 'The estimate could not be created.');
        return;
      }

      toast.success(result?.replayed ? 'Estimate already created' : 'Draft estimate created');
      router.push(`/accounts/${accountId}/estimates`);
      router.refresh();
    } catch {
      // Network failure: the key is deliberately kept. Retrying the same
      // payload replays instead of creating a duplicate.
      setServerError('Network error. It is safe to retry — no duplicate will be created.');
      toast.error('Network error. It is safe to retry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Details</CardTitle>
            <CardDescription>Draft estimate for {accountName}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="estimate-title">Title</Label>
              <Input
                id="estimate-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Website redesign"
                maxLength={200}
                aria-invalid={Boolean(fieldErrors.title)}
                aria-describedby={fieldErrors.title ? 'estimate-title-error' : undefined}
              />
              {fieldErrors.title && (
                <p id="estimate-title-error" className="text-destructive text-xs">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-number">Estimate number</Label>
              <Input
                id="estimate-number"
                value={estimateNumber}
                onChange={(event) => setEstimateNumber(event.target.value)}
                maxLength={64}
                className="font-mono"
                aria-invalid={Boolean(fieldErrors.estimate_number)}
              />
              {fieldErrors.estimate_number && (
                <p className="text-destructive text-xs">{fieldErrors.estimate_number}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-currency">Currency</Label>
              <Input
                id="estimate-currency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                maxLength={3}
                placeholder="USD"
                className="uppercase"
                aria-invalid={Boolean(fieldErrors.currency)}
              />
              {fieldErrors.currency && (
                <p className="text-destructive text-xs">{fieldErrors.currency}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-project">Project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="estimate-project" className="w-full">
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-tax">Tax rate % (optional)</Label>
              <Input
                id="estimate-tax"
                value={taxRate}
                onChange={(event) => setTaxRate(event.target.value)}
                placeholder="0"
                inputMode="decimal"
                aria-invalid={Boolean(fieldErrors.tax_rate)}
              />
              {fieldErrors.tax_rate && (
                <p className="text-destructive text-xs">{fieldErrors.tax_rate}</p>
              )}
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="estimate-description">Description (optional)</Label>
              <Textarea
                id="estimate-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Scope, assumptions, payment terms…"
                rows={3}
                maxLength={5000}
              />
              {fieldErrors.description && (
                <p className="text-destructive text-xs">{fieldErrors.description}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="text-lg">Line items</CardTitle>
                <CardDescription>Quantity × unit price per line.</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((current) => [...current, newLine()])}
                disabled={isSubmitting}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add line
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {lines.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                No line items yet. Add one to price this estimate.
              </p>
            ) : (
              lines.map((line, index) => {
                const amount = lineAmounts.get(line.key) ?? null;
                return (
                  <div key={line.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-12">
                    <div className="space-y-1 sm:col-span-5">
                      <Label htmlFor={`line-${index}-description`} className="text-xs">
                        Description
                      </Label>
                      <Input
                        id={`line-${index}-description`}
                        value={line.description}
                        onChange={(event) =>
                          updateLine(line.key, { description: event.target.value })
                        }
                        placeholder="Discovery workshop"
                        maxLength={500}
                        aria-invalid={Boolean(fieldErrors[`line_${index}_description`])}
                      />
                      {fieldErrors[`line_${index}_description`] && (
                        <p className="text-destructive text-xs">
                          {fieldErrors[`line_${index}_description`]}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor={`line-${index}-quantity`} className="text-xs">
                        Quantity
                      </Label>
                      <Input
                        id={`line-${index}-quantity`}
                        value={line.quantity}
                        onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                        placeholder="1"
                        inputMode="decimal"
                        aria-invalid={Boolean(fieldErrors[`line_${index}_quantity`])}
                      />
                      {fieldErrors[`line_${index}_quantity`] && (
                        <p className="text-destructive text-xs">
                          {fieldErrors[`line_${index}_quantity`]}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor={`line-${index}-price`} className="text-xs">
                        Unit price
                      </Label>
                      <Input
                        id={`line-${index}-price`}
                        value={line.unitPrice}
                        onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })}
                        placeholder="0.00"
                        inputMode="decimal"
                        aria-invalid={Boolean(fieldErrors[`line_${index}_unit_price`])}
                      />
                      {fieldErrors[`line_${index}_unit_price`] && (
                        <p className="text-destructive text-xs">
                          {fieldErrors[`line_${index}_unit_price`]}
                        </p>
                      )}
                    </div>

                    <div className="flex items-end justify-between gap-2 sm:col-span-3">
                      <div className="min-w-0">
                        <p className="text-muted-foreground text-xs">Amount</p>
                        <p className="truncate text-sm font-medium tabular-nums">
                          {amount === null ? '—' : formatMoney(amount, displayCurrency)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => moveLine(index, -1)}
                          disabled={index === 0 || isSubmitting}
                          aria-label={`Move line ${index + 1} up`}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => moveLine(index, 1)}
                          disabled={index === lines.length - 1 || isSubmitting}
                          aria-label={`Move line ${index + 1} down`}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setLines((current) => current.filter((item) => item.key !== line.key))
                          }
                          disabled={isSubmitting}
                          aria-label={`Remove line ${index + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="lg:sticky lg:top-6">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Summary</CardTitle>
            <CardDescription>Preview only — the server calculates the totals.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">
                {previewTotals ? formatMoney(previewTotals.subtotalMinor, displayCurrency) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Tax</span>
              <span className="tabular-nums">
                {previewTotals ? formatMoney(previewTotals.taxMinor, displayCurrency) : '—'}
              </span>
            </div>
            <div className="border-t pt-3">
              <div className="flex items-center justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {previewTotals ? formatMoney(previewTotals.totalMinor, displayCurrency) : '—'}
                </span>
              </div>
            </div>

            {serverError && (
              <div
                role="alert"
                className="border-destructive/30 bg-destructive/5 rounded-lg border p-3 text-sm"
              >
                <p className="text-foreground font-medium">{serverError}</p>
                {serverDetails.length > 0 && (
                  <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-4 text-xs">
                    {serverDetails.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting
                ? isEdit
                  ? 'Saving…'
                  : 'Creating…'
                : isEdit
                  ? 'Save changes'
                  : 'Create draft estimate'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => router.push(`/accounts/${accountId}/estimates`)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      </div>
    </form>
  );
}
