import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ChecklistPage from './ui/ChecklistPage'
import DayPage from './ui/DayPage'
import MapPage from './ui/MapPage'
import ShoppingPage from './ui/ShoppingPage'
import TripForm from './ui/TripForm'
import TripHome from './ui/TripHome'
import TripLayout from './ui/TripLayout'
import TripList from './ui/TripList'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TripList />} />
        <Route path="/trips/new" element={<TripForm />} />
        <Route path="/trips/:id/edit" element={<TripForm />} />
        <Route path="/trips/:id" element={<TripLayout />}>
          <Route index element={<TripHome />} />
          <Route path="day/:n" element={<DayPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="shopping" element={<ShoppingPage />} />
          <Route path="checklist" element={<ChecklistPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
