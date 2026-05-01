import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { QueryClient } from '@tanstack/react-query';
import type { ApiError } from '@/types';

// ---- Axios instance ----

// Accept both names so .env.production (`VITE_API_BASE_URL`) and any older
// dev configs (`VITE_API_URL`) work without a flag day.
const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  import.meta.env.VITE_API_URL ??
  '/api';

export const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true, // sends httpOnly cookie
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30_000,
});

// ---- Response interceptor: unwrap .data envelope ----
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error: string; message: string; statusCode: number }>) => {
    const apiErr: ApiError = {
      error: error.response?.data?.error ?? 'NetworkError',
      message:
        error.response?.data?.message ??
        error.message ??
        'An unexpected error occurred',
      statusCode: error.response?.status ?? 0,
    };
    return Promise.reject(apiErr);
  },
);

// ---- TanStack Query client ----

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30 seconds
      gcTime: 5 * 60 * 1_000, // 5 minutes
      retry: (failureCount, error) => {
        const apiErr = error as unknown as ApiError;
        // Don't retry on auth/permission errors
        if (apiErr.statusCode === 401 || apiErr.statusCode === 403 || apiErr.statusCode === 404) {
          return false;
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// ---- Typed API helpers ----

export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const response = await apiClient.get<{ data: T }>(url, { params });
  return response.data.data;
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await apiClient.post<{ data: T }>(url, body);
  return response.data.data;
}

export async function put<T>(url: string, body?: unknown): Promise<T> {
  const response = await apiClient.put<{ data: T }>(url, body);
  return response.data.data;
}

export async function del<T = void>(url: string): Promise<T> {
  const response = await apiClient.delete<{ data: T }>(url);
  return response.data.data;
}
