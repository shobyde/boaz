import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route path="/invoices" element={<Invoices />} />
    </Routes>
  );
}
