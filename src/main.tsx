import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import App, { Clients, Expenses, Inventory, Ledger, Overview, PersonProfile, Production, Products, Suppliers } from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Overview />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="production" element={<Production />} />
          <Route path="clients" element={<Clients />} />
          <Route path="clients/:id" element={<PersonProfile />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="suppliers/:id" element={<PersonProfile />} />
          <Route path="products" element={<Products />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
