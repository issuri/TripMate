import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ChecklistPage from './ui/ChecklistPage'
import DayPage from './ui/DayPage'
import MapPage from './ui/MapPage'
import ExpensesPage from './ui/ExpensesPage'
import JoinPage from './ui/JoinPage'
import LoginPage from './ui/LoginPage'
import OfflinePage from './ui/OfflinePage'
import SharePage from './ui/SharePage'
import ReminderHost from './ui/ReminderHost'
import SyncHost from './ui/SyncHost'
import ShoppingPage from './ui/ShoppingPage'
import TripForm from './ui/TripForm'
import TripHome from './ui/TripHome'
import TripLayout from './ui/TripLayout'
import TripList from './ui/TripList'

export default function App() {
  return (
    <BrowserRouter>
      <ReminderHost />
      <SyncHost />
      <Routes>
        <Route path="/" element={<TripList />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/trips/new" element={<TripForm />} />
        <Route path="/trips/:id/edit" element={<TripForm />} />
        <Route path="/trips/:id" element={<TripLayout />}>
          <Route index element={<TripHome />} />
          <Route path="day/:n" element={<DayPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="shopping" element={<ShoppingPage />} />
          <Route path="checklist" element={<ChecklistPage />} />
          <Route path="offline" element={<OfflinePage />} />
          <Route path="share" element={<SharePage />} />
          <Route path="expenses" element={<ExpensesPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
