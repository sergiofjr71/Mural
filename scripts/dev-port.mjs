/** Porta padrão do servidor de desenvolvimento (Cursor preview usa 3001). */
export const DEV_PORT = process.env.PORT || '3001';

export function devOrigin() {
  return `http://localhost:${DEV_PORT}`;
}
