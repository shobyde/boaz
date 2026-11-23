import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route path="/settings/billing" element={<Billing />} />
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
