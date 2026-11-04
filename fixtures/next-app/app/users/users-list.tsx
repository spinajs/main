'use client';
import { useUsersList } from '../../generated/client.react-query';

export function UsersList() {
  const { data, status } = useUsersList({ query: {} });
  if (!data) return <p>{status}</p>;
  return (
    <ul id="users">
      {data.map((user) => (
        <li key={user.id}>{user.email}</li>
      ))}
    </ul>
  );
}
