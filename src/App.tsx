import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import ChecklistPage from './ui/ChecklistPage'
import DayPage from './ui/DayPage'
import MapPage from './ui/MapPage'
import ExpensesPage from './ui/ExpensesPage'
import LoginPage from './ui/LoginPage'
import OfflinePage from './ui/OfflinePage'
import ReminderHost from './ui/ReminderHost'
import SyncHost from './ui/SyncHost'
import ShoppingPage from './ui/ShoppingPage'
import TripForm from './ui/TripForm'
import TripHome from './ui/TripHome'
import TripLayout from './ui/TripLayout'
import TripList from './ui/TripList'
import { ConfirmHost } from './ui/kit'

function TripHomeRedirect() {
  const { id } = useParams()
  return <Navigate to={`/trips/${id}`} replace />
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>{/* 하위 경로(예: /TripMate/)에서 서비스될 때를 위해 */}
      <ReminderHost />
      <SyncHost />
      <ConfirmHost />
      <Routes>
        <Route path="/" element={<TripList />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/trips/new" element={<TripForm />} />
        <Route path="/trips/:id/edit" element={<TripForm />} />
        <Route path="/trips/:id" element={<TripLayout />}>
          <Route index element={<TripHome />} />
          <Route path="day/:n" element={<DayPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="shopping" element={<ShoppingPage />} />
          <Route path="checklist" element={<ChecklistPage />} />
          <Route path="offline" element={<OfflinePage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="*" element={<TripHomeRedirect />} />   {/* 없어진 주소(예전 공유 화면 등)는 여행 홈으로 */}
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
