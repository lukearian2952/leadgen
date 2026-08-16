import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthGuard } from './components/auth/AuthGuard'
import { AppLayout } from './components/layout/AppLayout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { NewCampaignPage } from './pages/NewCampaignPage'
import { CampaignDetailPage } from './pages/CampaignDetailPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AuthGuard><AppLayout /></AuthGuard>}>
          <Route index element={<DashboardPage />} />
          <Route path="new" element={<NewCampaignPage />} />
          <Route path="campaign/:id" element={<CampaignDetailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
